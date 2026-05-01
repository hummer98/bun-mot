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
  BunMotElementNotInteractableError,
  type TimeoutCommandLabel,
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
      // §3.4 / §7.3: req.type で 3 分岐し expectedText / commandLabel を復元
      let selector: string;
      let timeoutMs: number;
      let expectedText: string | undefined;
      let commandLabel: TimeoutCommandLabel = "waitForSelector";
      if (req.type === "waitForSelector") {
        selector = req.selector;
        timeoutMs = req.timeout ?? 0;
      } else if (req.type === "waitForHidden") {
        selector = req.selector;
        timeoutMs = req.timeout ?? 0;
        commandLabel = "waitForHidden";
      } else if (req.type === "waitForText") {
        selector = req.selector;
        timeoutMs = req.timeout ?? 0;
        commandLabel = "waitForText";
        expectedText =
          req.text.kind === "string"
            ? req.text.value
            : `/${req.text.source}/${req.text.flags}`;
      } else {
        // 他 type で timeout は理論上発生しない (defensive fallback)
        selector = extractSelector(message);
        timeoutMs = 0;
      }
      const elapsedMs = extractElapsed(message);
      return new BunMotTimeoutError(selector, timeoutMs, elapsedMs, expectedText, commandLabel);
    }
    case "selector_not_found": {
      const selector = "selector" in req ? req.selector : extractSelector(message);
      return new BunMotSelectorNotFoundError(selector, req.type);
    }
    case "element_not_interactable": {
      const selector = "selector" in req ? req.selector : extractSelector(message);
      const reason = extractInteractableReason(message);
      return new BunMotElementNotInteractableError(selector, reason);
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

// "__BUNMOT_NOT_INTERACTABLE__:<selector>:<reason>" → <reason>
// selector / reason は Zod でガード済みのため空文字を含むケースは限定的。
function extractInteractableReason(message: string): string {
  const PREFIX = "__BUNMOT_NOT_INTERACTABLE__:";
  if (!message.startsWith(PREFIX)) return "unknown";
  const rest = message.slice(PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx === -1) return "unknown";
  return rest.slice(idx + 1) || "unknown";
}
