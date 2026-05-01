// 共通型エイリアス。CommandType は commands.ts で CommandRequest["type"] から派生させる。

import type { ScreenshotResult as ScreenshotResultType } from "./commands";
// screenshot の wire result 型は commands.ts の Zod schema から導出 (二重定義を避ける)。
export type { ScreenshotResult } from "./commands";

export type ErrorKind =
  | "validation_error"
  | "timeout"
  | "selector_not_found"
  | "evaluation_error"
  | "element_not_interactable"
  | "internal_error";

// Electrobun BrowserView の最小インタフェース (ダックタイピング)。
// Electrobun 1.16 builtin RPC のシグネチャに合わせて `{ script }` オブジェクト形で受け取る
// (electrobun/api/browser/builtinrpcSchema.ts: `params: { script: string }`)。
// 直接 `view.webview` を渡せば型整合する想定。
export interface BunMotView {
  rpc: {
    request: {
      evaluateJavascriptWithResponse(params: { script: string }): Promise<unknown>;
    };
  };
}

// 各コマンドの result 型
export type EvaluateResult = unknown;
export type WaitForSelectorResult = { found: true };
export type GetTextResult = { text: string };
export type ClickResult = { clicked: true };
export type FillResult = { filled: true };
export type WaitForHiddenResult = { hidden: true };
export type WaitForTextResult = { matched: true };
export type IsVisibleResult = { visible: boolean };
export type GetAttributeResult = { value: string | null };

export type ConsoleLogLevel = "log" | "warn" | "error";
export interface ConsoleLogEntry {
  level: ConsoleLogLevel;
  message: string;
  timestamp: number;
}
export interface GetLogsResult {
  entries: ConsoleLogEntry[];
  droppedCount: number;
  patchMissing: boolean;
}

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

export function isClickResult(value: unknown): value is ClickResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("clicked" in value)) return false;
  return (value as { clicked: unknown }).clicked === true;
}

export function isFillResult(value: unknown): value is FillResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("filled" in value)) return false;
  return (value as { filled: unknown }).filled === true;
}

export function isWaitForHiddenResult(value: unknown): value is WaitForHiddenResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("hidden" in value)) return false;
  return (value as { hidden: unknown }).hidden === true;
}

export function isWaitForTextResult(value: unknown): value is WaitForTextResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("matched" in value)) return false;
  return (value as { matched: unknown }).matched === true;
}

export function isIsVisibleResult(value: unknown): value is IsVisibleResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("visible" in value)) return false;
  return typeof (value as { visible: unknown }).visible === "boolean";
}

export function isGetAttributeResult(value: unknown): value is GetAttributeResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("value" in value)) return false;
  const v = (value as { value: unknown }).value;
  return typeof v === "string" || v === null;
}

export function isConsoleLogEntry(value: unknown): value is ConsoleLogEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { level?: unknown; message?: unknown; timestamp?: unknown };
  if (v.level !== "log" && v.level !== "warn" && v.level !== "error") return false;
  if (typeof v.message !== "string") return false;
  if (typeof v.timestamp !== "number") return false;
  return true;
}

export function isGetLogsResult(value: unknown): value is GetLogsResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as {
    entries?: unknown;
    droppedCount?: unknown;
    patchMissing?: unknown;
  };
  if (!Array.isArray(v.entries)) return false;
  if (!v.entries.every(isConsoleLogEntry)) return false;
  if (typeof v.droppedCount !== "number") return false;
  if (typeof v.patchMissing !== "boolean") return false;
  return true;
}

// screenshot の wire result type guard。dataUrl は "data:image/png;base64,..." 固定 (v1)。
export function isScreenshotResult(value: unknown): value is ScreenshotResultType {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { dataUrl?: unknown; byteCount?: unknown };
  if (typeof v.dataUrl !== "string") return false;
  if (!/^data:image\/png;base64,/.test(v.dataUrl)) return false;
  if (typeof v.byteCount !== "number") return false;
  if (!Number.isInteger(v.byteCount) || v.byteCount < 0) return false;
  return true;
}
