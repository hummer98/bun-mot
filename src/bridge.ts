import type { Server } from "bun";
import type { BunMotView, ErrorKind } from "./types";
import {
  CommandRequestSchema,
  type CommandRequest,
  type CommandResponse,
} from "./commands";
import { log } from "./logger";
import {
  buildEvaluateScript,
  buildWaitForSelectorScript,
  buildGetTextScript,
} from "./scripts";

export interface SetupBunMotOptions {
  port: number;
  /** 0.0.0.0 vs 127.0.0.1。デフォルトは 127.0.0.1 (ローカル限定) */
  hostname?: string;
}

export interface BunMotBridge {
  port: number;
  stop(): void;
}

// driver で値が埋まらなかった場合の bridge 側 fallback (§2.6)
const DEFAULT_TIMEOUT_MS = 5000;
const EXPRESSION_LOG_TRUNCATE = 200;

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

export function setupBunMot(view: BunMotView, opts: SetupBunMotOptions): BunMotBridge {
  const hostname = opts.hostname ?? "127.0.0.1";
  const server: Server<undefined> = Bun.serve({
    port: opts.port,
    hostname,
    fetch: (req) => handleHttpRequest(req, view),
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("Bun.serve did not assign a port");
  }
  log("bridge_started", { port, hostname });
  return {
    port,
    stop: (): void => {
      server.stop(true);
      log("bridge_stopped", { port });
    },
  };
}

async function handleHttpRequest(req: Request, view: BunMotView): Promise<Response> {
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

  const start = Date.now();
  try {
    const result = await dispatchCommand(cmd, view);
    const durationMs = Date.now() - start;
    log("command_completed", { type: cmd.type, success: true, durationMs });
    return jsonResponse(200, { success: true, result });
  } catch (e) {
    const { kind, message } = mapErrorToKind(e);
    const durationMs = Date.now() - start;
    log("command_completed", { type: cmd.type, success: false, durationMs, kind });
    log("command_failed", { type: cmd.type, kind, message });
    return jsonResponse(200, { success: false, error: { kind, message } });
  }
}

function commandReceivedFields(
  cmd: CommandRequest,
): Record<string, string | number | undefined> {
  const base: Record<string, string | number | undefined> = {
    type: cmd.type,
    viewId: cmd.viewId,
  };
  if (cmd.type === "evaluate") {
    base["expression"] = truncate(cmd.expression, EXPRESSION_LOG_TRUNCATE);
  } else if (cmd.type === "waitForSelector") {
    base["selector"] = cmd.selector;
    base["timeout"] = cmd.timeout;
  } else {
    base["selector"] = cmd.selector;
  }
  return base;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function dispatchCommand(cmd: CommandRequest, view: BunMotView): Promise<unknown> {
  // 同期エントリ (script 構築 + view メソッド呼び出し) で throw されたら internal_error。
  // 戻り値の Promise が reject した場合は WebView 側の Promise rejection として扱う。
  let scriptPromise: Promise<unknown>;
  try {
    const script = buildScriptForCommand(cmd);
    scriptPromise = view.rpc.request.evaluateJavascriptWithResponse(script);
  } catch (e) {
    throw new InternalDispatchError(e);
  }
  return await scriptPromise;
}

function buildScriptForCommand(cmd: CommandRequest): string {
  switch (cmd.type) {
    case "evaluate":
      return buildEvaluateScript(cmd.expression);
    case "waitForSelector":
      // §2.6: driver からは常に値が来るが、curl 等の直接呼び出し向けにここで fallback
      return buildWaitForSelectorScript(cmd.selector, cmd.timeout ?? DEFAULT_TIMEOUT_MS);
    case "getText":
      return buildGetTextScript(cmd.selector);
  }
}

// §4.4: WebView の reject 文字列 prefix から kind を分類
function mapErrorToKind(e: unknown): { kind: ErrorKind; message: string } {
  if (e instanceof InternalDispatchError) {
    return { kind: "internal_error", message: e.message };
  }
  if (typeof e === "string") {
    if (e.startsWith("__BUNMOT_TIMEOUT__:")) {
      return { kind: "timeout", message: e };
    }
    if (e.startsWith("__BUNMOT_SELECTOR_NOT_FOUND__:")) {
      return { kind: "selector_not_found", message: e };
    }
    return { kind: "evaluation_error", message: e };
  }
  if (e instanceof Error) {
    if (e.message.startsWith("__BUNMOT_TIMEOUT__:")) {
      return { kind: "timeout", message: e.message };
    }
    if (e.message.startsWith("__BUNMOT_SELECTOR_NOT_FOUND__:")) {
      return { kind: "selector_not_found", message: e.message };
    }
    return { kind: "evaluation_error", message: e.message };
  }
  return { kind: "internal_error", message: String(e) };
}

function jsonResponse(status: number, body: CommandResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
