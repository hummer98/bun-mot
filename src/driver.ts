import { BunMotClient } from "./client";
import { BunMotError } from "./errors";
import { selectConnectAdapter, waitForBridgeReady } from "./launch";
import type { ConnectAdapter } from "./launch";
import { log } from "./logger";
import {
  isClickResult,
  isFillResult,
  isGetAttributeResult,
  isGetLogsResult,
  isGetTextResult,
  isIsVisibleResult,
  isScreenshotResult,
  isWaitForHiddenResult,
  isWaitForSelectorResult,
  isWaitForTextResult,
} from "./types";
import type { ConsoleLogEntry, EvaluateResult } from "./types";
import type { CommandRequest, TextMatcher } from "./commands";

// `tsconfig.build.json` の `types: []` 方針 (Bun/Node ランタイム型を public .d.ts に漏出させない) を維持するため
// driver.ts 内で必要最小限の `Buffer` と `Bun.write` を inline 宣言する。
// runtime では Bun が `Buffer` (Node 互換 global) と `Bun.write` を提供する (engines.bun >=1.0.0)。
// (bridge.ts の `Bun.serve` と同じ戦略。bun-mot は Bun ランタイム前提のため Node fallback は不要。)

// `Buffer` は `ScreenshotReturn` の公開型に含まれるため interface として宣言する。
// Node.js の Buffer は Uint8Array のサブクラスなので extends Uint8Array とする。
interface Buffer extends Uint8Array {}
declare const Buffer: {
  from(input: string, encoding: "base64"): Buffer;
};

// 画面キャプチャをファイルに書き出すためだけに使用する。`fs.writeFile` 互換の挙動 (path 不正で raw throw)。
declare const Bun: {
  write(path: string, data: Uint8Array): Promise<number>;
};

export interface ScreenshotOptions {
  /**
   * `true` (default): document.documentElement (フルページ) を撮影。
   * `false`: document.body のみ。
   * 将来用に予約: `selector` (要素単位)、`type` ("png" | "jpeg")、`quality` (jpeg) は v1 では未サポート。
   */
  fullPage?: boolean;
}

// Playwright と異なり、`path` は第 1 引数の string で渡す (option-bag ではない)。
// path 指定時はファイルに書き出して { path, byteCount } を返し、
// 省略時は { buffer, byteCount } を返す。
export type ScreenshotReturn =
  | { buffer: Buffer; byteCount: number }
  | { path: string; byteCount: number };

export interface BunMotOptions {
  port: number;
  hostname?: string;
  /** T003 で複数 view を扱う際、すべてのリクエストに自動付与される識別子。v1 では bridge 側で無視される。 */
  viewId?: string;
  /** デフォルトタイムアウト (ms)。waitForSelector 等の `timeout` 未指定時に使われる。 */
  defaultTimeout?: number;
}

/**
 * `BunMot.attach()` のオプション。Playwright の `chromium.connectOverCDP({ port })` 相当。
 * launch() と異なり、子プロセスは attach() の所有外 (kill しない)。
 */
export interface AttachOptions {
  /** 接続先 bridge port (必須、整数 1〜65535) */
  port: number;
  /** 接続先 hostname (default: "127.0.0.1") */
  hostname?: string;
  /**
   * 接続成立までのタイムアウト (default: 5000ms)。
   * launch() の readyTimeout (10000ms) より短いのは、attach は spawn overhead を含まないため。
   */
  timeout?: number;
  /** 接続成立後に構築する BunMot の defaultTimeout (未指定なら BunMot constructor のデフォルトに従う) */
  defaultTimeout?: number;
  /**
   * @internal DI 用 (テストで TCP probe を差し替える)。プロダクションでは未指定。
   * launch の `connectAdapter` と同じ。README API テーブルからは除外する。
   */
  connectAdapter?: ConnectAdapter;
}

const ATTACH_DEFAULT_TIMEOUT_MS = 5000;

// 親 BunMot と BunMotScopedView が同じシグネチャで公開するコマンド集合。
// T002 が追加したコマンド (click / fill / waitForHidden / waitForText / isVisible /
// getAttribute / getLogs) を T003 マージ時に取り込み済み。
// 新コマンドを追加する場合はここと `BunMot` / `BunMotScopedView` の両方に追記する。
export interface BunMotCommands {
  evaluate(expression: string): Promise<EvaluateResult>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<void>;
  getText(selector: string): Promise<string>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  waitForHidden(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForText(
    selector: string,
    text: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  getAttribute(selector: string, attribute: string): Promise<string | null>;
  getLogs(): Promise<ConsoleLogEntry[]>;
  view(name: string): BunMotScopedView;
}

// 共通送信 helper: viewId 付与 + client.send への一元化。
// BunMot / BunMotScopedView 両方からこれを呼ぶ。直接 client.send を呼ばないこと (規約)。
// 新メソッド追加時もこの helper を経由させること。
async function sendCommand(
  client: BunMotClient,
  req: CommandRequest,
  viewId: string | undefined,
): Promise<unknown> {
  const withId: CommandRequest = viewId === undefined ? req : { ...req, viewId };
  return await client.send(withId);
}

// `waitForText` の wire-format 変換ヘルパー: string | RegExp → TextMatcher。
function toTextMatcher(text: string | RegExp): TextMatcher {
  return text instanceof RegExp
    ? { kind: "regex", source: text.source, flags: text.flags }
    : { kind: "string", value: text };
}

// `getLogs` の result shape 変換: patchMissing / droppedCount を warn entry に畳み込む。
function adaptLogsResult(result: {
  patchMissing: boolean;
  droppedCount: number;
  entries: ConsoleLogEntry[];
}): ConsoleLogEntry[] {
  if (result.patchMissing) {
    return [
      {
        level: "warn",
        message:
          "[bun-mot] console patch was not active when getLogs was called (page navigation may have reset it)",
        timestamp: Date.now(),
      },
    ];
  }
  if (result.droppedCount > 0) {
    return [
      {
        level: "warn",
        message: `[bun-mot] dropped ${result.droppedCount} earlier log entries`,
        timestamp: Date.now(),
      },
      ...result.entries,
    ];
  }
  return result.entries;
}

export class BunMot implements BunMotCommands {
  private readonly client: BunMotClient;
  private readonly defaultTimeout: number;
  private readonly viewId: string | undefined;
  /** dispose ログ等で参照する用に constructor で保持する。client.port は private のため。 */
  private readonly port: number;
  private disposed = false;

  constructor(opts: BunMotOptions) {
    this.client = new BunMotClient(opts.port, opts.hostname ?? "127.0.0.1");
    this.defaultTimeout = opts.defaultTimeout ?? 5000;
    this.viewId = opts.viewId;
    this.port = opts.port;
  }

  /**
   * 既存の bridge プロセスへ接続する static factory。Playwright の
   * `chromium.connectOverCDP({ port })` 相当。プロセスは attach() の所有外 (kill しない)。
   *
   * port は 1〜65535 の整数。範囲外・非整数は probe を 1 回も走らせず即時 validation_error。
   * timeout (default 5000ms) 内に TCP 接続が成立しなければ internal_error。
   */
  static async attach(options: AttachOptions): Promise<BunMot> {
    const { port } = options;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BunMotError(`attach: invalid port: ${port}`, "validation_error");
    }
    const hostname = options.hostname ?? "127.0.0.1";
    const timeout = options.timeout ?? ATTACH_DEFAULT_TIMEOUT_MS;
    const adapter = options.connectAdapter ?? selectConnectAdapter();

    log("attach_started", { port, hostname, timeout });
    const probe = await waitForBridgeReady(adapter, hostname, port, timeout);
    if (!probe.ok) {
      log("error", {
        event: "attach_timeout",
        elapsedMs: probe.elapsedMs,
        port,
        hostname,
      });
      throw new BunMotError(
        `bun-mot attach timeout after ${probe.elapsedMs}ms (last attempted: ${hostname}:${port})`,
        "internal_error",
      );
    }
    log("attach_completed", { port, hostname, elapsedMs: probe.elapsedMs });
    return new BunMot({
      port,
      hostname,
      defaultTimeout: options.defaultTimeout,
    });
  }

  /**
   * BunMot を使用済みとしてマークする。以降の command (`evaluate` 等) と `view()` は
   * `BunMotError(internal_error, "BunMot has been disposed")` を throw する。
   * **プロセスは kill しない** (attach() で接続したプロセスはユーザー所有)。
   *
   * 二度呼んでも throw しない (idempotent)。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    log("bunmot_disposed", { port: this.port });
  }

  /** disposed なら BunMotError(internal_error, "BunMot has been disposed") を throw。 */
  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new BunMotError("BunMot has been disposed", "internal_error");
    }
  }

  async evaluate(expression: string): Promise<EvaluateResult> {
    this.throwIfDisposed();
    return await sendCommand(this.client, { type: "evaluate", expression }, this.viewId);
  }

  async waitForSelector(selector: string, options?: { timeout?: number }): Promise<void> {
    this.throwIfDisposed();
    const timeout = options?.timeout ?? this.defaultTimeout;
    const result = await sendCommand(
      this.client,
      { type: "waitForSelector", selector, timeout },
      this.viewId,
    );
    if (!isWaitForSelectorResult(result)) {
      throw new BunMotError(
        `waitForSelector: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async getText(selector: string): Promise<string> {
    this.throwIfDisposed();
    const result = await sendCommand(
      this.client,
      { type: "getText", selector },
      this.viewId,
    );
    if (!isGetTextResult(result)) {
      throw new BunMotError(
        `getText: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return result.text;
  }

  async click(selector: string): Promise<void> {
    this.throwIfDisposed();
    const result = await sendCommand(
      this.client,
      { type: "click", selector },
      this.viewId,
    );
    if (!isClickResult(result)) {
      throw new BunMotError(
        `click: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async fill(selector: string, value: string): Promise<void> {
    this.throwIfDisposed();
    const result = await sendCommand(
      this.client,
      { type: "fill", selector, value },
      this.viewId,
    );
    if (!isFillResult(result)) {
      throw new BunMotError(
        `fill: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async waitForHidden(selector: string, options?: { timeout?: number }): Promise<void> {
    this.throwIfDisposed();
    const timeout = options?.timeout ?? this.defaultTimeout;
    const result = await sendCommand(
      this.client,
      { type: "waitForHidden", selector, timeout },
      this.viewId,
    );
    if (!isWaitForHiddenResult(result)) {
      throw new BunMotError(
        `waitForHidden: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async waitForText(
    selector: string,
    text: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void> {
    this.throwIfDisposed();
    const timeout = options?.timeout ?? this.defaultTimeout;
    const result = await sendCommand(
      this.client,
      { type: "waitForText", selector, text: toTextMatcher(text), timeout },
      this.viewId,
    );
    if (!isWaitForTextResult(result)) {
      throw new BunMotError(
        `waitForText: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async isVisible(selector: string): Promise<boolean> {
    this.throwIfDisposed();
    const result = await sendCommand(
      this.client,
      { type: "isVisible", selector },
      this.viewId,
    );
    if (!isIsVisibleResult(result)) {
      throw new BunMotError(
        `isVisible: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return result.visible;
  }

  async getAttribute(selector: string, attribute: string): Promise<string | null> {
    this.throwIfDisposed();
    const result = await sendCommand(
      this.client,
      { type: "getAttribute", selector, attribute },
      this.viewId,
    );
    if (!isGetAttributeResult(result)) {
      throw new BunMotError(
        `getAttribute: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return result.value;
  }

  // Playwright 互換: path を省略すると Buffer を返す、指定するとファイルに書き出す。
  // 注: Playwright の `page.screenshot()` は options.path 形式だが、bun-mot は第 1 引数 string。
  async screenshot(): Promise<{ buffer: Buffer; byteCount: number }>;
  async screenshot(
    path: string,
    options?: ScreenshotOptions,
  ): Promise<{ path: string; byteCount: number }>;
  async screenshot(
    path?: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotReturn> {
    this.throwIfDisposed();
    const fullPage = options?.fullPage ?? true;
    const result = await sendCommand(
      this.client,
      { type: "screenshot", fullPage },
      this.viewId,
    );
    if (!isScreenshotResult(result)) {
      throw new BunMotError(
        `screenshot: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64, "base64");
    // wire の byteCount はサニティチェックのみ。driver は常に buffer.byteLength を返す。
    // 値が極端に異なる (倍以上 / 半分以下) なら warn を残す (throw しない)。
    if (
      result.byteCount > 0 &&
      (result.byteCount > buffer.byteLength * 2 ||
        buffer.byteLength > result.byteCount * 2)
    ) {
      log("screenshot_bytecount_mismatch", {
        wireByteCount: result.byteCount,
        decodedByteCount: buffer.byteLength,
      });
    }
    if (path !== undefined) {
      // path === "" は Playwright と同様 Bun.write (内部 fs) が ENOENT 等で raw throw する。
      // bun-mot 側でガードしないのは「意図しない使い方」を呼び出し側責務にする方針。
      await Bun.write(path, buffer);
      log("screenshot_saved", { path, byteCount: buffer.byteLength });
      return { path, byteCount: buffer.byteLength };
    }
    log("screenshot_returned_buffer", { byteCount: buffer.byteLength });
    return { buffer, byteCount: buffer.byteLength };
  }

  async getLogs(): Promise<ConsoleLogEntry[]> {
    this.throwIfDisposed();
    const result = await sendCommand(this.client, { type: "getLogs" }, this.viewId);
    if (!isGetLogsResult(result)) {
      throw new BunMotError(
        `getLogs: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return adaptLogsResult(result);
  }

  /**
   * 指定 view にスコープしたハンドルを返す。返り値の各メソッドは request body に
   * `viewId: name` を自動付与する。親 BunMot の状態は変えない (immutable scope)。
   *
   * v1 では bridge が単一 view にしか向かないため、複数 view への切替は機能しない。
   * 詳細は README §「複数 view と view() の v1 制限」を参照。
   *
   * dispose 後の `view()` 呼び出しは throw する (新しい scoped view の発行は不整合のため禁止)。
   * 既に取得済みの BunMotScopedView は v1 では親の disposed flag を見ない (将来 v2 で再検討)。
   */
  view(name: string): BunMotScopedView {
    this.throwIfDisposed();
    return new BunMotScopedView(this.client, this.defaultTimeout, name);
  }

  /**
   * 全アサーションが成功した旨を user-facing に表示する。`BUN_MOT_LOG=silent` でも出す
   * ため `console.log` を使う。リソース cleanup は持たず、`launch()` の `app.close()` の責務。
   * 将来 cleanup や file write 等への拡張を破壊的変更にしないため最初から `Promise<void>`。
   */
  async pass(message?: string): Promise<void> {
    const suffix = message !== undefined ? ` (${message})` : "";
    console.log(`🚐✅ bun-mot: all assertions passed${suffix}`);
  }
}

/**
 * `BunMot.view(name)` で得られるスコープ付きハンドル。親 BunMot から `client` /
 * `defaultTimeout` を **値渡しで受け取り** 自分の private に保持する委譲方式 (composition)。
 * 親の private は緩めず、親への back-reference も持たない。
 *
 * `view().view()` は **replace 方式** (最後の name が勝つ): `mot.view('a').view('b')` の
 * viewId は `'b'`。stack/push-pop ではない。
 */
export class BunMotScopedView implements BunMotCommands {
  private readonly client: BunMotClient;
  private readonly defaultTimeout: number;
  private readonly viewId: string;

  constructor(client: BunMotClient, defaultTimeout: number, viewId: string) {
    this.client = client;
    this.defaultTimeout = defaultTimeout;
    this.viewId = viewId;
  }

  async evaluate(expression: string): Promise<EvaluateResult> {
    return await sendCommand(this.client, { type: "evaluate", expression }, this.viewId);
  }

  async waitForSelector(selector: string, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const result = await sendCommand(
      this.client,
      { type: "waitForSelector", selector, timeout },
      this.viewId,
    );
    if (!isWaitForSelectorResult(result)) {
      throw new BunMotError(
        `waitForSelector: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async getText(selector: string): Promise<string> {
    const result = await sendCommand(
      this.client,
      { type: "getText", selector },
      this.viewId,
    );
    if (!isGetTextResult(result)) {
      throw new BunMotError(
        `getText: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return result.text;
  }

  async click(selector: string): Promise<void> {
    const result = await sendCommand(
      this.client,
      { type: "click", selector },
      this.viewId,
    );
    if (!isClickResult(result)) {
      throw new BunMotError(
        `click: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async fill(selector: string, value: string): Promise<void> {
    const result = await sendCommand(
      this.client,
      { type: "fill", selector, value },
      this.viewId,
    );
    if (!isFillResult(result)) {
      throw new BunMotError(
        `fill: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async waitForHidden(selector: string, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const result = await sendCommand(
      this.client,
      { type: "waitForHidden", selector, timeout },
      this.viewId,
    );
    if (!isWaitForHiddenResult(result)) {
      throw new BunMotError(
        `waitForHidden: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async waitForText(
    selector: string,
    text: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const result = await sendCommand(
      this.client,
      { type: "waitForText", selector, text: toTextMatcher(text), timeout },
      this.viewId,
    );
    if (!isWaitForTextResult(result)) {
      throw new BunMotError(
        `waitForText: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async isVisible(selector: string): Promise<boolean> {
    const result = await sendCommand(
      this.client,
      { type: "isVisible", selector },
      this.viewId,
    );
    if (!isIsVisibleResult(result)) {
      throw new BunMotError(
        `isVisible: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return result.visible;
  }

  async getAttribute(selector: string, attribute: string): Promise<string | null> {
    const result = await sendCommand(
      this.client,
      { type: "getAttribute", selector, attribute },
      this.viewId,
    );
    if (!isGetAttributeResult(result)) {
      throw new BunMotError(
        `getAttribute: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return result.value;
  }

  async getLogs(): Promise<ConsoleLogEntry[]> {
    const result = await sendCommand(this.client, { type: "getLogs" }, this.viewId);
    if (!isGetLogsResult(result)) {
      throw new BunMotError(
        `getLogs: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return adaptLogsResult(result);
  }

  // chain (`.view('a').view('b')`) は replace 方式: 最後の name が勝つ。
  view(name: string): BunMotScopedView {
    return new BunMotScopedView(this.client, this.defaultTimeout, name);
  }
}
