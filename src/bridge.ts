import type { BunMotView, ErrorKind } from "./types";
import {
  CommandRequestSchema,
  type CommandRequest,
  type CommandResponse,
  type WaitForHiddenRequest,
  type WaitForSelectorRequest,
  type WaitForTextRequest,
} from "./commands";
import { log } from "./logger";
import {
  buildEvaluateScript,
  buildWaitForSelectorScript,
  buildGetTextScript,
  buildClickScript,
  buildFillScript,
  buildIsVisibleScript,
  buildGetAttributeScript,
  buildWaitForHiddenScript,
  buildWaitForTextScript,
  buildConsolePatchScript,
  buildEnsurePatchScript,
  buildGetLogsScript,
  buildScreenshotScript,
  isWaitChunkResult,
} from "./scripts";

// `tsconfig.build.json` で `types: []` を採用し、@types/bun の global を含めない方針のため
// (公開 .d.ts に Bun ランタイム型を漏出させない)、bridge.ts 内で必要最小限の `Bun` 形を inline 宣言する。
// runtime では Bun が globalThis に存在することが前提 (engines.bun >=1.0.0)。
declare const Bun: {
  serve: (opts: {
    port: number;
    hostname: string;
    fetch: (req: Request) => Promise<Response>;
  }) => { port?: number; stop: (force?: boolean) => void };
};

export interface SetupBunMotOptions {
  port: number;
  /** 0.0.0.0 vs 127.0.0.1。デフォルトは 127.0.0.1 (ローカル限定) */
  hostname?: string;
  /**
   * console patch の bootstrap inject に許可するタイムアウト (ms)。
   * Electrobun 1.16 RPC のデフォルト 1s では不足するケースがあるため、defaultTimeout に揃える。
   * 0 / 負値を渡しても bootstrap は実行する (timeout が即発火するだけ)。
   * @default 5000
   */
  bootstrapTimeoutMs?: number;
  /**
   * 1 チャンクあたりの内部 timeout (ms)。Electrobun 1.16 preload の 10s WS timeout を
   * 回避するため、bridge は wait 系コマンドをこの値以下のチャンクに分割して繰り返し評価する。
   * デフォルト 5000ms (10s 制限に対する 50% 安全マージン)。
   * 注意: 8000 を超える値は preload の 10s 制限に当たるリスクが上がるため非推奨。
   */
  chunkTimeoutMs?: number;
}

export interface BunMotBridge {
  port: number;
  stop(): void;
}

// driver で値が埋まらなかった場合の bridge 側 fallback (§2.6)
const DEFAULT_TIMEOUT_MS = 5000;
// console patch の bootstrap inject に許可するタイムアウト (ms)。
// driver の defaultTimeout と意図的に揃える (#5)。
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5000;
// 1 チャンクあたりの WebView 側 setTimeout 既定値。Electrobun preload の 10s 制限に対する
// 50% 安全マージン。setupBunMot({ chunkTimeoutMs }) で上書き可能。
const DEFAULT_CHUNK_TIMEOUT_MS = 5000;
const EXPRESSION_LOG_TRUNCATE = 200;

// wait 系コマンド (chunk loop の対象)
type WaitCommand = WaitForSelectorRequest | WaitForHiddenRequest | WaitForTextRequest;

function isWaitCommand(cmd: CommandRequest): cmd is WaitCommand {
  return (
    cmd.type === "waitForSelector" ||
    cmd.type === "waitForHidden" ||
    cmd.type === "waitForText"
  );
}

// dispatch の同期エントリ (script 構築 / view メソッド呼び出し時) で投げられた throw は
// bridge / view 接続側の内部例外として `internal_error` に分類する。
// WebView の Promise rejection (await scriptPromise の reject) とは区別する。
class InternalDispatchError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "InternalDispatchError";
    this.cause = cause;
  }
}

interface BridgeState {
  // §4.1: 初回 console patch inject 用 Promise キャッシュ。並行コマンドで二重 inject されないようにする。
  bootstrapPromise: Promise<void> | null;
  // 初回 inject が成功したか。失敗時は ensure script も呼ばない (永続的な patch 不在を許容)。
  bootstrappedAtLeastOnce: boolean;
  // bootstrap / ensure inject 双方の race timeout (ms)。SetupBunMotOptions から伝播。
  bootstrapTimeoutMs: number;
  // wait 系 chunk loop で 1 chunk あたりに使う WebView 側 setTimeout の長さ (ms)。
  chunkTimeoutMs: number;
}

export function setupBunMot(view: BunMotView, opts: SetupBunMotOptions): BunMotBridge {
  const hostname = opts.hostname ?? "127.0.0.1";
  const chunkTimeoutMs = opts.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
  // chunkTimeoutMs <= 0 は無限ループ相当の挙動を招くため API 境界で reject (M-2)。
  if (!Number.isFinite(chunkTimeoutMs) || chunkTimeoutMs <= 0) {
    throw new Error(
      `setupBunMot: chunkTimeoutMs must be a positive finite number (got ${String(chunkTimeoutMs)})`,
    );
  }
  const state: BridgeState = {
    bootstrapPromise: null,
    bootstrappedAtLeastOnce: false,
    bootstrapTimeoutMs: opts.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    chunkTimeoutMs,
  };
  const server = Bun.serve({
    port: opts.port,
    hostname,
    fetch: (req) => handleHttpRequest(req, view, state),
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("Bun.serve did not assign a port");
  }
  log("bridge_started", { port, hostname, chunkTimeoutMs });
  return {
    port,
    stop: (): void => {
      server.stop(true);
      log("bridge_stopped", { port });
    },
  };
}

async function handleHttpRequest(
  req: Request,
  view: BunMotView,
  state: BridgeState,
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname !== "/command") {
    log("command_validation_failed", { reason: "path_not_found", path: url.pathname });
    return jsonResponse(404, {
      success: false,
      error: { kind: "validation_error", message: "Not found" },
    });
  }
  if (req.method !== "POST") {
    log("command_validation_failed", { reason: "method_not_allowed", method: req.method });
    return jsonResponse(405, {
      success: false,
      error: { kind: "validation_error", message: "Method not allowed" },
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    log("command_validation_failed", { reason: "json_parse_error" });
    return jsonResponse(400, {
      success: false,
      error: { kind: "validation_error", message: "Invalid JSON" },
    });
  }

  const parsed = CommandRequestSchema.safeParse(json);
  if (!parsed.success) {
    log("command_validation_failed", { reason: "schema_violation", issues: parsed.error.message });
    return jsonResponse(400, {
      success: false,
      error: { kind: "validation_error", message: parsed.error.message },
    });
  }
  const cmd: CommandRequest = parsed.data;

  log("command_received", commandReceivedFields(cmd));

  // §4.1: dispatchCommand 前に console patch を bootstrap / ensure する。
  await ensureConsolePatch(view, state);

  // §plan §6.2: screenshot は固有ログを追加発火 (byteCount を可視化するため)。
  if (cmd.type === "screenshot") {
    log("screenshot_started", {
      viewId: cmd.viewId,
      fullPage: cmd.fullPage ?? true,
    });
  }

  const start = Date.now();
  try {
    const result = await dispatchCommand(cmd, view, state);
    const durationMs = Date.now() - start;
    log("command_completed", { type: cmd.type, success: true, durationMs });
    if (cmd.type === "screenshot") {
      const byteCount =
        typeof result === "object" &&
        result !== null &&
        "byteCount" in result &&
        typeof (result as { byteCount: unknown }).byteCount === "number"
          ? (result as { byteCount: number }).byteCount
          : -1;
      log("screenshot_completed", {
        viewId: cmd.viewId,
        byteCount,
        durationMs,
      });
    }
    return jsonResponse(200, { success: true, result });
  } catch (e) {
    const { kind, message } = mapErrorToKind(e);
    const durationMs = Date.now() - start;
    log("command_completed", { type: cmd.type, success: false, durationMs, kind });
    log("command_failed", { type: cmd.type, kind, message });
    if (cmd.type === "screenshot") {
      log("screenshot_failed", { viewId: cmd.viewId, kind, message });
    }
    return jsonResponse(200, { success: false, error: { kind, message } });
  }
}

// console patch inject は best-effort (#5)。
// bootstrap が timeout / reject しても `console_patch_failed` をログするだけで後続 command は実行する。
// 副作用: bootstrap 失敗後は `getLogs` が `patchMissing: true` を返し続ける (bridge 再起動まで再試行しない)。
async function ensureConsolePatch(view: BunMotView, state: BridgeState): Promise<void> {
  if (!state.bootstrapPromise) {
    state.bootstrapPromise = (async (): Promise<void> => {
      try {
        await raceWithTimeout(
          view.rpc.request.evaluateJavascriptWithResponse({ script: buildConsolePatchScript() }),
          state.bootstrapTimeoutMs,
          "bootstrap_inject_timeout",
        );
        state.bootstrappedAtLeastOnce = true;
        log("console_patch_applied", { phase: "bootstrap" });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log("console_patch_failed", { phase: "bootstrap", message });
      }
    })();
  }
  await state.bootstrapPromise;

  if (!state.bootstrappedAtLeastOnce) return;
  // navigation / reload 復旧用。失敗してもメインコマンド実行は継続。
  try {
    await raceWithTimeout(
      view.rpc.request.evaluateJavascriptWithResponse({ script: buildEnsurePatchScript() }),
      state.bootstrapTimeoutMs,
      "ensure_inject_timeout",
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("console_patch_ensure_failed", { message });
  }
}

// race timer の loser 側は inner Promise の reject/resolve を捨てる前提。
// finally で setTimeout を確実に解除し、成功時の dangling timer を残さない。
async function raceWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function commandReceivedFields(
  cmd: CommandRequest,
): Record<string, string | number | boolean | undefined> {
  const base: Record<string, string | number | boolean | undefined> = {
    type: cmd.type,
    viewId: cmd.viewId,
  };
  switch (cmd.type) {
    case "evaluate":
      base["expression"] = truncate(cmd.expression, EXPRESSION_LOG_TRUNCATE);
      break;
    case "waitForSelector":
      base["selector"] = cmd.selector;
      base["timeout"] = cmd.timeout;
      break;
    case "getText":
      base["selector"] = cmd.selector;
      break;
    case "click":
      base["selector"] = cmd.selector;
      break;
    case "fill":
      // §3.3 m4: value はログに出さず valueLength のみ記録 (機密情報保護)
      base["selector"] = cmd.selector;
      base["valueLength"] = cmd.value.length;
      break;
    case "waitForHidden":
      base["selector"] = cmd.selector;
      base["timeout"] = cmd.timeout;
      break;
    case "waitForText":
      // text の中身 (value / source) は記録せず kind のみ
      base["selector"] = cmd.selector;
      base["timeout"] = cmd.timeout;
      base["textKind"] = cmd.text.kind;
      break;
    case "isVisible":
      base["selector"] = cmd.selector;
      break;
    case "getAttribute":
      base["selector"] = cmd.selector;
      base["attribute"] = cmd.attribute;
      break;
    case "getLogs":
      // 追加フィールドなし
      break;
    case "screenshot":
      // dataUrl はサイズ・機密の双方の理由でログに出さない (§plan §6.2)。
      base["fullPage"] = cmd.fullPage ?? true;
      break;
  }
  return base;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function dispatchCommand(
  cmd: CommandRequest,
  view: BunMotView,
  state: BridgeState,
): Promise<unknown> {
  // wait 系は chunk loop 経由 (Electrobun preload 10s WS timeout 回避)。
  if (isWaitCommand(cmd)) {
    return await dispatchWaitChunkLoop(cmd, view, state.chunkTimeoutMs);
  }
  // wait 系以外は単発 evaluate。
  // 同期エントリ (script 構築 + view メソッド呼び出し) で throw されたら internal_error。
  // 戻り値の Promise が reject した場合は WebView 側の Promise rejection として扱う。
  let scriptPromise: Promise<unknown>;
  try {
    const script = buildScriptForCommand(cmd);
    scriptPromise = view.rpc.request.evaluateJavascriptWithResponse({ script });
  } catch (e) {
    throw new InternalDispatchError(e);
  }
  return await scriptPromise;
}

// wait 系以外の単発 evaluate 用 script ビルダー。wait 系は dispatchWaitChunkLoop を経由する。
function buildScriptForCommand(cmd: Exclude<CommandRequest, WaitCommand>): string {
  switch (cmd.type) {
    case "evaluate":
      return buildEvaluateScript(cmd.expression);
    case "getText":
      return buildGetTextScript(cmd.selector);
    case "click":
      return buildClickScript(cmd.selector);
    case "fill":
      return buildFillScript(cmd.selector, cmd.value);
    case "isVisible":
      return buildIsVisibleScript(cmd.selector);
    case "getAttribute":
      return buildGetAttributeScript(cmd.selector, cmd.attribute);
    case "getLogs":
      return buildGetLogsScript();
    case "screenshot":
      return buildScreenshotScript({ fullPage: cmd.fullPage ?? true });
  }
}

// wait 系コマンドを chunk に分割して繰り返し評価する dispatch ループ。
// - 1 chunk: WebView 側 chunk script を 1 回 evaluate (`{ matched, elapsed }` で resolve)
// - matched: true → 既存 wire-format (`{ found: true }` 等) に変換して返す
// - 全体 timeout 到達 → `__BUNMOT_TIMEOUT__:<selector>:<elapsed>` を throw
//   (mapErrorToKind が `kind: "timeout"` にマップ → 既存 client / errors と完全互換)
//
// 累計 elapsed は **chunkResult.elapsed と実時間 (Date.now()) の大きい方** を加算する:
// - 実 WebView では chunk script 内 setTimeout が thisChunkMs まで待つため
//   `chunkResult.elapsed ≈ thisChunkMs` (matched: false の場合) → 12 chunks で 60s 進む
// - WebView 異常 (elapsed = 0 / 嘘の値) → 実時間 (Date.now() - chunkStart) で進む
// この設計により mock テストでは chunkResult.elapsed (嘘でも整合性のある値) で進められ、
// 実 WebView では chunkTimeoutMs ベースで進む。エラーメッセージとログには実時間を使う。
async function dispatchWaitChunkLoop(
  cmd: WaitCommand,
  view: BunMotView,
  chunkTimeoutMs: number,
): Promise<unknown> {
  const totalTimeout = cmd.timeout ?? DEFAULT_TIMEOUT_MS;
  const selector = cmd.selector;
  const startedAt = Date.now();
  let progress = 0;
  let chunks = 0;
  for (;;) {
    const remaining = totalTimeout - progress;
    if (remaining <= 0) break;
    const thisChunkMs = Math.min(chunkTimeoutMs, remaining);
    const chunkStart = Date.now();

    let chunkResult: unknown;
    try {
      const script = buildScriptForChunk(cmd, thisChunkMs);
      chunkResult = await view.rpc.request.evaluateJavascriptWithResponse({ script });
    } catch (e) {
      // WebView 内 throw / preload 切断は既存 mapErrorToKind に委ねる (timeout / evaluation_error 等)。
      throw e;
    }
    chunks++;

    if (!isWaitChunkResult(chunkResult)) {
      throw new InternalDispatchError(
        new Error(
          `wait chunk returned unexpected shape: ${JSON.stringify(chunkResult)}`,
        ),
      );
    }

    const realElapsed = Date.now() - chunkStart;
    // 進捗は WebView 側 elapsed と実時間の大きい方。matched: false なら本来 thisChunkMs 経過しているはず。
    // 万一 chunkResult.elapsed = 0 でも実時間で 1ms 以上進むので無限ループにならない。
    const chunkProgress = Math.max(chunkResult.elapsed, realElapsed, 1);
    progress += chunkProgress;

    log("wait_chunk_completed", {
      type: cmd.type,
      selector,
      matched: chunkResult.matched,
      chunkElapsedMs: chunkResult.elapsed,
      totalElapsedMs: Date.now() - startedAt,
      thisChunkMs,
    });

    if (chunkResult.matched) {
      return waitSuccessShape(cmd.type);
    }
  }

  const totalElapsedMs = Date.now() - startedAt;
  log("wait_total_timeout", {
    type: cmd.type,
    selector,
    timeoutMs: totalTimeout,
    totalElapsedMs,
    chunks,
  });
  // mapErrorToKind が `__BUNMOT_TIMEOUT__:` prefix で `kind: "timeout"` にマップする。
  // throw する値は文字列 (Promise reject value): client.ts:67-98 の mapErrorResponse が
  // selector と elapsed を分割して BunMotTimeoutError を構築する。
  throw `__BUNMOT_TIMEOUT__:${selector}:${totalElapsedMs}`;
}

function buildScriptForChunk(cmd: WaitCommand, chunkTimeoutMs: number): string {
  switch (cmd.type) {
    case "waitForSelector":
      return buildWaitForSelectorScript(cmd.selector, chunkTimeoutMs);
    case "waitForHidden":
      return buildWaitForHiddenScript(cmd.selector, chunkTimeoutMs);
    case "waitForText":
      return buildWaitForTextScript(cmd.selector, cmd.text, chunkTimeoutMs);
  }
}

function waitSuccessShape(
  type: WaitCommand["type"],
):
  | { found: true }
  | { hidden: true }
  | { matched: true } {
  switch (type) {
    case "waitForSelector":
      return { found: true };
    case "waitForHidden":
      return { hidden: true };
    case "waitForText":
      return { matched: true };
  }
}

// §4.4: WebView の reject 文字列 prefix から kind を分類
function mapErrorToKind(e: unknown): { kind: ErrorKind; message: string } {
  if (e instanceof InternalDispatchError) {
    return { kind: "internal_error", message: e.message };
  }
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : null;
  if (text !== null) {
    if (text.startsWith("__BUNMOT_TIMEOUT__:")) {
      return { kind: "timeout", message: text };
    }
    if (text.startsWith("__BUNMOT_SELECTOR_NOT_FOUND__:")) {
      return { kind: "selector_not_found", message: text };
    }
    if (text.startsWith("__BUNMOT_NOT_INTERACTABLE__:")) {
      return { kind: "element_not_interactable", message: text };
    }
    return { kind: "evaluation_error", message: text };
  }
  return { kind: "internal_error", message: String(e) };
}

function jsonResponse(status: number, body: CommandResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
