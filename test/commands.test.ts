import { describe, expect, test } from "bun:test";
import {
  CommandRequestSchema,
  CommandResponseSchema,
  EvaluateRequestSchema,
  WaitForSelectorRequestSchema,
  GetTextRequestSchema,
  BaseRequestSchema,
} from "../src/commands";
import type { CommandRequest, CommandResponse, CommandType } from "../src/commands";

describe("CommandRequestSchema", () => {
  test("evaluate コマンドをパースできる", () => {
    const parsed = CommandRequestSchema.parse({
      type: "evaluate",
      expression: "1 + 1",
    });
    expect(parsed.type).toBe("evaluate");
    if (parsed.type === "evaluate") {
      expect(parsed.expression).toBe("1 + 1");
    }
  });

  test("waitForSelector コマンドをパースできる (timeout なし)", () => {
    const parsed = CommandRequestSchema.parse({
      type: "waitForSelector",
      selector: ".foo",
    });
    expect(parsed.type).toBe("waitForSelector");
    if (parsed.type === "waitForSelector") {
      expect(parsed.selector).toBe(".foo");
      expect(parsed.timeout).toBeUndefined();
    }
  });

  test("waitForSelector コマンドをパースできる (timeout 指定)", () => {
    const parsed = CommandRequestSchema.parse({
      type: "waitForSelector",
      selector: ".foo",
      timeout: 1000,
    });
    if (parsed.type === "waitForSelector") {
      expect(parsed.timeout).toBe(1000);
    }
  });

  test("waitForSelector の timeout は .default(5000) されない (driver 単一所有)", () => {
    // §2.6: driver が defaultTimeout を埋める。Zod が default で埋めると二重管理になる
    const parsed = WaitForSelectorRequestSchema.parse({
      type: "waitForSelector",
      selector: ".foo",
    });
    expect(parsed.timeout).toBeUndefined();
  });

  test("getText コマンドをパースできる", () => {
    const parsed = CommandRequestSchema.parse({
      type: "getText",
      selector: "h1",
    });
    if (parsed.type === "getText") {
      expect(parsed.selector).toBe("h1");
    }
  });

  test("viewId は optional として全コマンドに含まれる", () => {
    const evaluateWithView = CommandRequestSchema.parse({
      type: "evaluate",
      expression: "1+1",
      viewId: "main",
    });
    expect(evaluateWithView.viewId).toBe("main");

    const evaluateWithoutView = CommandRequestSchema.parse({
      type: "evaluate",
      expression: "1+1",
    });
    expect(evaluateWithoutView.viewId).toBeUndefined();

    const waitWithView = CommandRequestSchema.parse({
      type: "waitForSelector",
      selector: ".x",
      viewId: "secondary",
    });
    expect(waitWithView.viewId).toBe("secondary");

    const getTextWithView = CommandRequestSchema.parse({
      type: "getText",
      selector: "h1",
      viewId: "tertiary",
    });
    expect(getTextWithView.viewId).toBe("tertiary");
  });

  test("不正な type で fail する", () => {
    const result = CommandRequestSchema.safeParse({
      type: "unknown",
      expression: "1+1",
    });
    expect(result.success).toBe(false);
  });

  test("evaluate で expression 欠落で fail する", () => {
    const result = CommandRequestSchema.safeParse({ type: "evaluate" });
    expect(result.success).toBe(false);
  });

  test("waitForSelector で selector 欠落で fail する", () => {
    const result = CommandRequestSchema.safeParse({ type: "waitForSelector" });
    expect(result.success).toBe(false);
  });

  test("waitForSelector の timeout が負数で fail する", () => {
    const result = CommandRequestSchema.safeParse({
      type: "waitForSelector",
      selector: ".x",
      timeout: -1,
    });
    expect(result.success).toBe(false);
  });

  test("waitForSelector の timeout が小数で fail する", () => {
    const result = CommandRequestSchema.safeParse({
      type: "waitForSelector",
      selector: ".x",
      timeout: 1.5,
    });
    expect(result.success).toBe(false);
  });

  test("BaseRequestSchema 単独でも viewId が optional として扱える", () => {
    expect(BaseRequestSchema.parse({}).viewId).toBeUndefined();
    expect(BaseRequestSchema.parse({ viewId: "x" }).viewId).toBe("x");
  });
});

describe("CommandResponseSchema", () => {
  test("success レスポンスをパースできる", () => {
    const parsed = CommandResponseSchema.parse({
      success: true,
      result: 42,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.result).toBe(42);
    }
  });

  test("error レスポンスをパースできる", () => {
    const parsed = CommandResponseSchema.parse({
      success: false,
      error: { message: "timeout", kind: "timeout" },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.kind).toBe("timeout");
      expect(parsed.error.message).toBe("timeout");
    }
  });

  test("不正な kind で fail する", () => {
    const result = CommandResponseSchema.safeParse({
      success: false,
      error: { message: "x", kind: "unknown_kind" },
    });
    expect(result.success).toBe(false);
  });
});

describe("型導出", () => {
  test("CommandType は CommandRequest['type'] から派生される", () => {
    // コンパイル時の型チェックを実行時で確認
    const valid: CommandType[] = ["evaluate", "waitForSelector", "getText"];
    expect(valid).toEqual(["evaluate", "waitForSelector", "getText"]);
  });

  test("CommandRequest 型を type narrowing で使える", () => {
    const req: CommandRequest = { type: "evaluate", expression: "1+1" };
    if (req.type === "evaluate") {
      expect(req.expression).toBe("1+1");
    }
  });

  test("CommandResponse 型で success による narrow が効く", () => {
    const ok: CommandResponse = { success: true, result: "x" };
    if (ok.success) {
      expect(ok.result).toBe("x");
    }
  });
});
