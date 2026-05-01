import { z } from "zod";

// 共通フィールド: viewId は v1 では未使用だが T003 用に枠を確保。
export const BaseRequestSchema = z.object({
  viewId: z.string().optional(),
});

export const EvaluateRequestSchema = BaseRequestSchema.extend({
  type: z.literal("evaluate"),
  expression: z.string(),
});

export const WaitForSelectorRequestSchema = BaseRequestSchema.extend({
  type: z.literal("waitForSelector"),
  selector: z.string(),
  // §2.6: driver が必ず埋めるが、curl 等の直接送信のため optional + bridge 側 fallback。
  // .default(5000) は使わない (driver の defaultTimeout と二重管理になるため)。
  timeout: z.number().int().positive().optional(),
});

export const GetTextRequestSchema = BaseRequestSchema.extend({
  type: z.literal("getText"),
  selector: z.string(),
});

export const ClickRequestSchema = BaseRequestSchema.extend({
  type: z.literal("click"),
  selector: z.string(),
});

export const FillRequestSchema = BaseRequestSchema.extend({
  type: z.literal("fill"),
  selector: z.string(),
  value: z.string(),
});

export const WaitForHiddenRequestSchema = BaseRequestSchema.extend({
  type: z.literal("waitForHidden"),
  selector: z.string(),
  timeout: z.number().int().positive().optional(),
});

// waitForText の text は wire-format では JSON にできないため discriminated union で送る。
export const TextMatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("string"), value: z.string() }),
  z.object({ kind: z.literal("regex"), source: z.string(), flags: z.string() }),
]);
export type TextMatcher = z.infer<typeof TextMatcherSchema>;

export const WaitForTextRequestSchema = BaseRequestSchema.extend({
  type: z.literal("waitForText"),
  selector: z.string(),
  text: TextMatcherSchema,
  timeout: z.number().int().positive().optional(),
});

export const IsVisibleRequestSchema = BaseRequestSchema.extend({
  type: z.literal("isVisible"),
  selector: z.string(),
});

export const GetAttributeRequestSchema = BaseRequestSchema.extend({
  type: z.literal("getAttribute"),
  selector: z.string(),
  attribute: z.string().min(1),
});

export const GetLogsRequestSchema = BaseRequestSchema.extend({
  type: z.literal("getLogs"),
});

export const ScreenshotRequestSchema = BaseRequestSchema.extend({
  type: z.literal("screenshot"),
  // 既定 true (driver / bridge fallback)。ページ全体 (documentElement) か body だけかの切替。
  fullPage: z.boolean().optional(),
});

export const ScreenshotResultSchema = z.object({
  // bridge → driver は base64 dataURL のみ送る (path 解決は driver 側)。
  dataUrl: z.string().regex(/^data:image\/png;base64,/),
  // base64 デコード後のバイト数 (driver 側のサニティチェック用)。
  byteCount: z.number().int().nonnegative(),
});

export const CommandRequestSchema = z.discriminatedUnion("type", [
  EvaluateRequestSchema,
  WaitForSelectorRequestSchema,
  GetTextRequestSchema,
  ClickRequestSchema,
  FillRequestSchema,
  WaitForHiddenRequestSchema,
  WaitForTextRequestSchema,
  IsVisibleRequestSchema,
  GetAttributeRequestSchema,
  GetLogsRequestSchema,
  ScreenshotRequestSchema,
]);

export type CommandRequest = z.infer<typeof CommandRequestSchema>;
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;
export type WaitForSelectorRequest = z.infer<typeof WaitForSelectorRequestSchema>;
export type GetTextRequest = z.infer<typeof GetTextRequestSchema>;
export type ClickRequest = z.infer<typeof ClickRequestSchema>;
export type FillRequest = z.infer<typeof FillRequestSchema>;
export type WaitForHiddenRequest = z.infer<typeof WaitForHiddenRequestSchema>;
export type WaitForTextRequest = z.infer<typeof WaitForTextRequestSchema>;
export type IsVisibleRequest = z.infer<typeof IsVisibleRequestSchema>;
export type GetAttributeRequest = z.infer<typeof GetAttributeRequestSchema>;
export type GetLogsRequest = z.infer<typeof GetLogsRequestSchema>;
export type ScreenshotRequest = z.infer<typeof ScreenshotRequestSchema>;
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;

// §2.11: CommandType は CommandRequest["type"] から派生
export type CommandType = CommandRequest["type"];

export const ErrorKindSchema = z.enum([
  "validation_error",
  "timeout",
  "selector_not_found",
  "evaluation_error",
  "element_not_interactable",
  "internal_error",
]);

export const CommandSuccessResponseSchema = z.object({
  success: z.literal(true),
  result: z.unknown(),
});

export const CommandErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    message: z.string(),
    kind: ErrorKindSchema,
  }),
});

export const CommandResponseSchema = z.union([
  CommandSuccessResponseSchema,
  CommandErrorResponseSchema,
]);

export type CommandResponse = z.infer<typeof CommandResponseSchema>;
export type CommandSuccessResponse = z.infer<typeof CommandSuccessResponseSchema>;
export type CommandErrorResponse = z.infer<typeof CommandErrorResponseSchema>;
