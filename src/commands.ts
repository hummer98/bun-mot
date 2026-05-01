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

export const CommandRequestSchema = z.discriminatedUnion("type", [
  EvaluateRequestSchema,
  WaitForSelectorRequestSchema,
  GetTextRequestSchema,
]);

export type CommandRequest = z.infer<typeof CommandRequestSchema>;
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;
export type WaitForSelectorRequest = z.infer<typeof WaitForSelectorRequestSchema>;
export type GetTextRequest = z.infer<typeof GetTextRequestSchema>;

// §2.11: CommandType は CommandRequest["type"] から派生
export type CommandType = CommandRequest["type"];

export const ErrorKindSchema = z.enum([
  "validation_error",
  "timeout",
  "selector_not_found",
  "evaluation_error",
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
