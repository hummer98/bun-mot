import { describe, expect, test } from "bun:test";
import {
  CommandRequestSchema,
  CommandResponseSchema,
  ErrorKindSchema,
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
  test("CommandType は CommandRequest['type'] から派生される (10 種)", () => {
    // コンパイル時の型チェックを実行時で確認
    const valid: CommandType[] = [
      "evaluate",
      "waitForSelector",
      "getText",
      "click",
      "fill",
      "waitForHidden",
      "waitForText",
      "isVisible",
      "getAttribute",
      "getLogs",
    ];
    expect(valid).toEqual([
      "evaluate",
      "waitForSelector",
      "getText",
      "click",
      "fill",
      "waitForHidden",
      "waitForText",
      "isVisible",
      "getAttribute",
      "getLogs",
    ]);
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

describe("ClickRequestSchema", () => {
  test("click コマンドをパースできる", () => {
    const parsed = CommandRequestSchema.parse({
      type: "click",
      selector: ".btn",
    });
    expect(parsed.type).toBe("click");
    if (parsed.type === "click") {
      expect(parsed.selector).toBe(".btn");
    }
  });

  test("selector が欠落で fail する", () => {
    const result = ClickRequestSchema.safeParse({ type: "click" });
    expect(result.success).toBe(false);
  });

  test("selector が string でないと fail する", () => {
    const result = ClickRequestSchema.safeParse({ type: "click", selector: 1 });
    expect(result.success).toBe(false);
  });

  test("viewId optional", () => {
    const parsed = ClickRequestSchema.parse({
      type: "click",
      selector: ".btn",
      viewId: "main",
    });
    expect(parsed.viewId).toBe("main");
  });
});

describe("FillRequestSchema", () => {
  test("fill コマンドをパースできる", () => {
    const parsed = CommandRequestSchema.parse({
      type: "fill",
      selector: ".input",
      value: "hello",
    });
    expect(parsed.type).toBe("fill");
    if (parsed.type === "fill") {
      expect(parsed.value).toBe("hello");
    }
  });

  test("value が欠落で fail する", () => {
    const result = FillRequestSchema.safeParse({ type: "fill", selector: ".x" });
    expect(result.success).toBe(false);
  });

  test("value が空文字でも pass する (Playwright 互換: 空にする操作)", () => {
    const result = FillRequestSchema.safeParse({
      type: "fill",
      selector: ".x",
      value: "",
    });
    expect(result.success).toBe(true);
  });
});

describe("WaitForHiddenRequestSchema", () => {
  test("waitForHidden コマンドをパースできる (timeout なし)", () => {
    const parsed = CommandRequestSchema.parse({
      type: "waitForHidden",
      selector: ".x",
    });
    if (parsed.type === "waitForHidden") {
      expect(parsed.selector).toBe(".x");
      expect(parsed.timeout).toBeUndefined();
    }
  });

  test("timeout 指定で pass", () => {
    const parsed = WaitForHiddenRequestSchema.parse({
      type: "waitForHidden",
      selector: ".x",
      timeout: 1000,
    });
    expect(parsed.timeout).toBe(1000);
  });

  test("timeout が負数で fail", () => {
    const r = WaitForHiddenRequestSchema.safeParse({
      type: "waitForHidden",
      selector: ".x",
      timeout: -1,
    });
    expect(r.success).toBe(false);
  });

  test("timeout は default されない (driver 単一所有)", () => {
    const parsed = WaitForHiddenRequestSchema.parse({
      type: "waitForHidden",
      selector: ".x",
    });
    expect(parsed.timeout).toBeUndefined();
  });
});

describe("WaitForTextRequestSchema", () => {
  test("string matcher を受け付ける", () => {
    const parsed = WaitForTextRequestSchema.parse({
      type: "waitForText",
      selector: ".x",
      text: { kind: "string", value: "hello" },
    });
    expect(parsed.text.kind).toBe("string");
    if (parsed.text.kind === "string") {
      expect(parsed.text.value).toBe("hello");
    }
  });

  test("regex matcher を受け付ける", () => {
    const parsed = WaitForTextRequestSchema.parse({
      type: "waitForText",
      selector: ".x",
      text: { kind: "regex", source: "h.+", flags: "i" },
    });
    if (parsed.text.kind === "regex") {
      expect(parsed.text.source).toBe("h.+");
      expect(parsed.text.flags).toBe("i");
    }
  });

  test("text の kind が unknown だと fail", () => {
    const r = WaitForTextRequestSchema.safeParse({
      type: "waitForText",
      selector: ".x",
      text: { kind: "wrong", value: "x" },
    });
    expect(r.success).toBe(false);
  });

  test("regex で flags が string でないと fail", () => {
    const r = WaitForTextRequestSchema.safeParse({
      type: "waitForText",
      selector: ".x",
      text: { kind: "regex", source: "h", flags: 1 },
    });
    expect(r.success).toBe(false);
  });

  test("timeout 指定可", () => {
    const parsed = WaitForTextRequestSchema.parse({
      type: "waitForText",
      selector: ".x",
      text: { kind: "string", value: "hi" },
      timeout: 2000,
    });
    expect(parsed.timeout).toBe(2000);
  });
});

describe("IsVisibleRequestSchema", () => {
  test("isVisible コマンドをパースできる", () => {
    const parsed = CommandRequestSchema.parse({
      type: "isVisible",
      selector: ".x",
    });
    expect(parsed.type).toBe("isVisible");
  });

  test("selector 欠落で fail", () => {
    const r = IsVisibleRequestSchema.safeParse({ type: "isVisible" });
    expect(r.success).toBe(false);
  });
});

describe("GetAttributeRequestSchema", () => {
  test("getAttribute コマンドをパースできる", () => {
    const parsed = CommandRequestSchema.parse({
      type: "getAttribute",
      selector: ".x",
      attribute: "data-id",
    });
    if (parsed.type === "getAttribute") {
      expect(parsed.attribute).toBe("data-id");
    }
  });

  test("attribute 欠落で fail", () => {
    const r = GetAttributeRequestSchema.safeParse({
      type: "getAttribute",
      selector: ".x",
    });
    expect(r.success).toBe(false);
  });

  test("attribute が空文字で fail", () => {
    const r = GetAttributeRequestSchema.safeParse({
      type: "getAttribute",
      selector: ".x",
      attribute: "",
    });
    expect(r.success).toBe(false);
  });
});

describe("GetLogsRequestSchema", () => {
  test("getLogs コマンドをパースできる (selector 等不要)", () => {
    const parsed = CommandRequestSchema.parse({ type: "getLogs" });
    expect(parsed.type).toBe("getLogs");
  });

  test("viewId optional", () => {
    const parsed = GetLogsRequestSchema.parse({
      type: "getLogs",
      viewId: "main",
    });
    expect(parsed.viewId).toBe("main");
  });
});

describe("ErrorKindSchema (拡張)", () => {
  test("element_not_interactable を含む", () => {
    expect(ErrorKindSchema.safeParse("element_not_interactable").success).toBe(true);
  });
});
