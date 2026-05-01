import type { ErrorKind } from "./types";

// expression をエラーメッセージに含める際の最大文字数 (§6.3 と整合)
const EXPRESSION_TRUNCATE_LIMIT = 200;

export class BunMotError extends Error {
  readonly kind: ErrorKind;
  constructor(message: string, kind: ErrorKind) {
    super(message);
    this.name = "BunMotError";
    this.kind = kind;
  }
}

export class BunMotTimeoutError extends BunMotError {
  readonly selector: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  constructor(selector: string, timeoutMs: number, elapsedMs: number) {
    super(
      `waitForSelector timeout: "${selector}" not found within ${timeoutMs}ms (elapsed: ${elapsedMs}ms)`,
      "timeout",
    );
    this.name = "BunMotTimeoutError";
    this.selector = selector;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

export class BunMotSelectorNotFoundError extends BunMotError {
  readonly selector: string;
  readonly command: string;
  constructor(selector: string, command: string) {
    super(`${command}: selector "${selector}" not found`, "selector_not_found");
    this.name = "BunMotSelectorNotFoundError";
    this.selector = selector;
    this.command = command;
  }
}

export class BunMotEvaluationError extends BunMotError {
  readonly expression: string;
  readonly originalMessage: string;
  constructor(expression: string, originalMessage: string) {
    const truncated =
      expression.length > EXPRESSION_TRUNCATE_LIMIT
        ? expression.slice(0, EXPRESSION_TRUNCATE_LIMIT) + "…"
        : expression;
    super(`evaluate failed: "${truncated}" → ${originalMessage}`, "evaluation_error");
    this.name = "BunMotEvaluationError";
    this.expression = expression;
    this.originalMessage = originalMessage;
  }
}
