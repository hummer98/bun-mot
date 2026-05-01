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

// §7.3: commandLabel デフォルトは "waitForSelector" で既存メッセージを 1 文字も変えない。
// expectedText 指定時は waitForText 用フォーマットに切り替え。
// commandLabel "waitForHidden" 時は専用フォーマット。
export type TimeoutCommandLabel =
  | "waitForSelector"
  | "waitForHidden"
  | "waitForText";

export class BunMotTimeoutError extends BunMotError {
  readonly selector: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly expectedText?: string | undefined;
  readonly commandLabel: TimeoutCommandLabel;
  constructor(
    selector: string,
    timeoutMs: number,
    elapsedMs: number,
    expectedText?: string,
    commandLabel: TimeoutCommandLabel = "waitForSelector",
  ) {
    const message = buildTimeoutMessage(
      commandLabel,
      selector,
      timeoutMs,
      elapsedMs,
      expectedText,
    );
    super(message, "timeout");
    this.name = "BunMotTimeoutError";
    this.selector = selector;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
    this.expectedText = expectedText;
    this.commandLabel = commandLabel;
  }
}

function buildTimeoutMessage(
  label: TimeoutCommandLabel,
  selector: string,
  timeoutMs: number,
  elapsedMs: number,
  expectedText: string | undefined,
): string {
  if (label === "waitForHidden") {
    return `waitForHidden timeout: "${selector}" still visible within ${timeoutMs}ms (elapsed: ${elapsedMs}ms)`;
  }
  if (label === "waitForText") {
    const expected = expectedText ?? "";
    return `waitForText timeout: "${selector}" did not match "${expected}" within ${timeoutMs}ms (elapsed: ${elapsedMs}ms)`;
  }
  // waitForSelector: 既存メッセージと完全一致
  return `waitForSelector timeout: "${selector}" not found within ${timeoutMs}ms (elapsed: ${elapsedMs}ms)`;
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

export class BunMotElementNotInteractableError extends BunMotError {
  readonly selector: string;
  readonly reason: string;
  constructor(selector: string, reason: string) {
    super(
      `element not interactable: "${selector}" (${reason})`,
      "element_not_interactable",
    );
    this.name = "BunMotElementNotInteractableError";
    this.selector = selector;
    this.reason = reason;
  }
}
