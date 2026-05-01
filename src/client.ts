import {
  CommandResponseSchema,
  type CommandRequest,
  type CommandErrorResponse,
} from "./commands";
import {
  BunMotError,
  BunMotTimeoutError,
  BunMotSelectorNotFoundError,
  BunMotEvaluationError,
} from "./errors";
import { log } from "./logger";

export class BunMotClient {
  private readonly port: number;
  private readonly hostname: string;

  constructor(port: number, hostname: string) {
    this.port = port;
    this.hostname = hostname;
  }

  async send(request: CommandRequest): Promise<unknown> {
    const url = `http://${this.hostname}:${this.port}/command`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log("error", { event: "client_fetch_failed", url, message });
      throw new BunMotError(`bun-mot client: failed to reach bridge at ${url}: ${message}`, "internal_error");
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log("error", { event: "client_response_parse_failed", url, message });
      throw new BunMotError(
        `bun-mot client: invalid JSON response from bridge: ${message}`,
        "internal_error",
      );
    }

    const parsed = CommandResponseSchema.safeParse(json);
    if (!parsed.success) {
      log("error", { event: "client_response_schema_failed", message: parsed.error.message });
      throw new BunMotError(
        `bun-mot client: response did not match schema: ${parsed.error.message}`,
        "internal_error",
      );
    }
    if (parsed.data.success) {
      return parsed.data.result;
    }
    throw mapErrorResponse(parsed.data, request);
  }
}

function mapErrorResponse(res: CommandErrorResponse, req: CommandRequest): BunMotError {
  const { kind, message } = res.error;
  switch (kind) {
    case "timeout": {
      // メッセージ形式: __BUNMOT_TIMEOUT__:<selector>:<elapsed>
      const selector = req.type === "waitForSelector" ? req.selector : extractSelector(message);
      const timeoutMs =
        req.type === "waitForSelector" && typeof req.timeout === "number" ? req.timeout : 0;
      const elapsedMs = extractElapsed(message);
      return new BunMotTimeoutError(selector, timeoutMs, elapsedMs);
    }
    case "selector_not_found": {
      const selector = "selector" in req ? req.selector : extractSelector(message);
      return new BunMotSelectorNotFoundError(selector, req.type);
    }
    case "evaluation_error": {
      const expression = req.type === "evaluate" ? req.expression : "";
      return new BunMotEvaluationError(expression, message);
    }
    case "validation_error":
    case "internal_error":
      return new BunMotError(message, kind);
  }
}

// "__BUNMOT_TIMEOUT__:.foo:5000" → ".foo"
function extractSelector(message: string): string {
  const parts = message.split(":");
  return parts[1] ?? "";
}

// "__BUNMOT_TIMEOUT__:.foo:5000" → 5000
function extractElapsed(message: string): number {
  const parts = message.split(":");
  const last = parts[parts.length - 1];
  if (last === undefined) return 0;
  const n = Number(last);
  return Number.isFinite(n) ? n : 0;
}
