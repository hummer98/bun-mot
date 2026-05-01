// 共通型エイリアス。CommandType は commands.ts で CommandRequest["type"] から派生させる。

export type ErrorKind =
  | "validation_error"
  | "timeout"
  | "selector_not_found"
  | "evaluation_error"
  | "internal_error";

// Electrobun BrowserView の最小インタフェース (ダックタイピング)
export interface BunMotView {
  rpc: {
    request: {
      evaluateJavascriptWithResponse(script: string): Promise<unknown>;
    };
  };
}

// 各コマンドの result 型
export type EvaluateResult = unknown;
export type WaitForSelectorResult = { found: true };
export type GetTextResult = { text: string };

// driver で result を narrow するための型ガード
export function isGetTextResult(value: unknown): value is GetTextResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("text" in value)) return false;
  const text = (value as { text: unknown }).text;
  return typeof text === "string";
}

export function isWaitForSelectorResult(value: unknown): value is WaitForSelectorResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("found" in value)) return false;
  return (value as { found: unknown }).found === true;
}
