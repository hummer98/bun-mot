import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { setupBunMot } from "../src/bridge";
import type { BunMotBridge } from "../src/bridge";
import type { BunMotView } from "../src/types";

// テスト中はログを抑制
beforeAll(() => {
  process.env["BUN_MOT_LOG"] = "silent";
});

afterAll(() => {
  delete process.env["BUN_MOT_LOG"];
});

type EvalImpl = (script: string) => Promise<unknown>;

function createMockView(evalImpl: EvalImpl): {
  view: BunMotView;
  evaluateMock: ReturnType<typeof mock<EvalImpl>>;
} {
  const evaluateMock = mock(evalImpl);
  const view: BunMotView = {
    rpc: { request: { evaluateJavascriptWithResponse: evaluateMock } },
  };
  return { view, evaluateMock };
}

async function postCommand(bridge: BunMotBridge, body: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${bridge.port}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("setupBunMot - 起動 / 停止", () => {
  test("port: 0 でランダムポートが割り当てられる", () => {
    const { view } = createMockView(async () => null);
    const bridge = setupBunMot(view, { port: 0 });
    expect(bridge.port).toBeGreaterThan(0);
    bridge.stop();
  });

  test("stop() 後はリクエストが ECONNREFUSED になる", async () => {
    const { view } = createMockView(async () => null);
    const bridge = setupBunMot(view, { port: 0 });
    const port = bridge.port;
    bridge.stop();
    let threw = false;
    try {
      await fetch(`http://127.0.0.1:${port}/command`, {
        method: "POST",
        body: "{}",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("POST /command - 正常系", () => {
  test("evaluate 正常系: 結果がそのまま返る", async () => {
    const { view, evaluateMock } = createMockView(async () => 42);
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "evaluate", expression: "1+1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; result?: unknown };
    expect(body).toEqual({ success: true, result: 42 });
    // §4.1: console patch bootstrap (1) + ensure (2) + 実コマンド (3)
    expect(evaluateMock).toHaveBeenCalledTimes(3);
    bridge.stop();
  });

  test("waitForSelector 正常系: { found: true } が返る", async () => {
    const { view } = createMockView(async () => ({ found: true }));
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 1000,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, result: { found: true } });
    bridge.stop();
  });

  test("getText 正常系: { text: 'hello' } が返る", async () => {
    const { view } = createMockView(async () => ({ text: "hello" }));
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "getText", selector: "h1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, result: { text: "hello" } });
    bridge.stop();
  });

  test("viewId 付きリクエストが 200 OK で処理される (v1 では無視)", async () => {
    const { view } = createMockView(async () => 1);
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "evaluate",
      expression: "1+1",
      viewId: "main",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    bridge.stop();
  });

  test("waitForSelector で timeout 未指定でも bridge が 5000ms にフォールバック", async () => {
    const { view, evaluateMock } = createMockView(async () => ({ found: true }));
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
    });
    expect(res.status).toBe(200);
    // §4.1: bootstrap (1) + ensure (2) + 実コマンド (3)。最後の呼び出しに 5000 が埋め込まれている
    const calls = evaluateMock.mock.calls;
    expect(calls).toHaveLength(3);
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    if (lastCall) {
      expect(lastCall[0]).toContain("5000");
    }
    bridge.stop();
  });
});

describe("POST /command - バリデーション", () => {
  test("不正な JSON で 400", async () => {
    const { view } = createMockView(async () => null);
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, "{not valid json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { kind: string } };
    expect(body.success).toBe(false);
    expect(body.error.kind).toBe("validation_error");
    bridge.stop();
  });

  test("type 欠落で 400", async () => {
    const { view } = createMockView(async () => null);
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { expression: "1+1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { kind: string } };
    expect(body.error.kind).toBe("validation_error");
    bridge.stop();
  });

  test("不明な type で 400", async () => {
    const { view } = createMockView(async () => null);
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "definitelyUnknownType", selector: ".x" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe("validation_error");
    bridge.stop();
  });
});

describe("POST /command - エラーマッピング", () => {
  test("__BUNMOT_TIMEOUT__ prefix で reject → kind: timeout", async () => {
    const { view } = createMockView(async () => {
      throw "__BUNMOT_TIMEOUT__:.foo:5000";
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 5000,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      error: { kind: string; message: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.kind).toBe("timeout");
    bridge.stop();
  });

  test("__BUNMOT_SELECTOR_NOT_FOUND__ prefix で reject → kind: selector_not_found", async () => {
    const { view } = createMockView(async () => {
      throw "__BUNMOT_SELECTOR_NOT_FOUND__:h1";
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "getText", selector: "h1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      error: { kind: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.kind).toBe("selector_not_found");
    bridge.stop();
  });

  test("Error オブジェクト reject → kind: evaluation_error", async () => {
    const { view } = createMockView(async () => {
      throw new Error("syntax error");
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "evaluate",
      expression: "throw new Error('x')",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      error: { kind: string; message: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.kind).toBe("evaluation_error");
    expect(body.error.message).toContain("syntax error");
    bridge.stop();
  });

  test("不明な reject 文字列 → kind: evaluation_error", async () => {
    const { view } = createMockView(async () => {
      throw "some random string";
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "evaluate",
      expression: "x",
    });
    const body = (await res.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe("evaluation_error");
    bridge.stop();
  });

  test("bridge 内部の同期 throw → kind: internal_error", async () => {
    const view: BunMotView = {
      rpc: {
        request: {
          // 同期的に throw する
          evaluateJavascriptWithResponse: ((): never => {
            throw new Error("internal boom");
          }) as unknown as (script: string) => Promise<unknown>,
        },
      },
    };
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "evaluate", expression: "1+1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe("internal_error");
    bridge.stop();
  });
});

describe("HTTP メソッド / パス違反", () => {
  test("GET /command → 405", async () => {
    const { view } = createMockView(async () => null);
    const bridge = setupBunMot(view, { port: 0 });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/command`, { method: "GET" });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { success: boolean; error: { kind: string; message: string } };
    expect(body.success).toBe(false);
    expect(body.error.kind).toBe("validation_error");
    expect(body.error.message).toBe("Method not allowed");
    bridge.stop();
  });

  test("POST /other → 404", async () => {
    const { view } = createMockView(async () => null);
    const bridge = setupBunMot(view, { port: 0 });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/other`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: { kind: string; message: string } };
    expect(body.success).toBe(false);
    expect(body.error.kind).toBe("validation_error");
    expect(body.error.message).toBe("Not found");
    bridge.stop();
  });
});

describe("POST /command - 新コマンド (T002)", () => {
  test("click 正常系: { clicked: true } が返る", async () => {
    const { view, evaluateMock } = createMockView(async (script: string) => {
      // bootstrap / ensure 用 inject は undefined を返す。実コマンドで {clicked:true}
      if (script.includes(".click()")) return { clicked: true };
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "click", selector: ".btn" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, result: { clicked: true } });
    expect(evaluateMock).toHaveBeenCalled();
    bridge.stop();
  });

  test("click で __BUNMOT_NOT_INTERACTABLE__ → kind: element_not_interactable", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes(".click()")) {
        throw "__BUNMOT_NOT_INTERACTABLE__:.btn:not_html_element";
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "click", selector: ".btn" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe("element_not_interactable");
    bridge.stop();
  });

  test("fill 正常系: { filled: true } が返る", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("dispatchEvent")) return { filled: true };
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "fill",
      selector: ".input",
      value: "hi",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, result: { filled: true } });
    bridge.stop();
  });

  test("fill で element_not_interactable", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("HTMLInputElement")) {
        throw "__BUNMOT_NOT_INTERACTABLE__:.x:not_input_or_textarea";
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "fill",
      selector: ".x",
      value: "v",
    });
    const body = (await res.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe("element_not_interactable");
    bridge.stop();
  });

  test("waitForHidden 正常系", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("hidden")) return { hidden: true };
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "waitForHidden",
      selector: ".x",
      timeout: 1000,
    });
    expect(await res.json()).toEqual({ success: true, result: { hidden: true } });
    bridge.stop();
  });

  test("waitForHidden で timeout reject → kind: timeout", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("hidden")) {
        throw "__BUNMOT_TIMEOUT__:.x:1000";
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "waitForHidden",
      selector: ".x",
      timeout: 1000,
    });
    const body = (await res.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe("timeout");
    bridge.stop();
  });

  test("waitForText 正常系: wire-format (string) を script に含む", async () => {
    let lastCommandScript = "";
    const { view } = createMockView(async (script: string) => {
      if (script.includes("matched")) {
        lastCommandScript = script;
        return { matched: true };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "waitForText",
      selector: ".x",
      text: { kind: "string", value: "hello" },
      timeout: 1000,
    });
    expect(res.status).toBe(200);
    expect(lastCommandScript).toContain("includes");
    expect(lastCommandScript).toContain("hello");
    bridge.stop();
  });

  test("waitForText 正常系: wire-format (regex) を script に含む", async () => {
    let lastCommandScript = "";
    const { view } = createMockView(async (script: string) => {
      if (script.includes("matched")) {
        lastCommandScript = script;
        return { matched: true };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    await postCommand(bridge, {
      type: "waitForText",
      selector: ".x",
      text: { kind: "regex", source: "h.+", flags: "i" },
      timeout: 1000,
    });
    expect(lastCommandScript).toContain("RegExp");
    expect(lastCommandScript).toContain("h.+");
    bridge.stop();
  });

  test("isVisible が { visible: boolean } を返す", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("getBoundingClientRect")) return { visible: true };
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "isVisible", selector: ".x" });
    expect(await res.json()).toEqual({ success: true, result: { visible: true } });
    bridge.stop();
  });

  test("getAttribute が { value: string | null } を返す", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("getAttribute")) return { value: "abc" };
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "getAttribute",
      selector: ".x",
      attribute: "data-id",
    });
    expect(await res.json()).toEqual({ success: true, result: { value: "abc" } });
    bridge.stop();
  });

  test("getAttribute で属性なしのとき value: null", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("getAttribute")) return { value: null };
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "getAttribute",
      selector: ".x",
      attribute: "data-id",
    });
    expect(await res.json()).toEqual({ success: true, result: { value: null } });
    bridge.stop();
  });

  test("getLogs 正常系: entries / droppedCount / patchMissing が返る", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("__BUNMOT_LOGS__") && script.includes("patchMissing")) {
        return {
          entries: [{ level: "log", message: "hi", timestamp: 100 }],
          droppedCount: 0,
          patchMissing: false,
        };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "getLogs" });
    const body = (await res.json()) as {
      success: boolean;
      result: { entries: unknown[]; droppedCount: number; patchMissing: boolean };
    };
    expect(body.success).toBe(true);
    expect(body.result.entries).toHaveLength(1);
    expect(body.result.patchMissing).toBe(false);
    bridge.stop();
  });
});

describe("Console patch bootstrap / ensure", () => {
  test("最初のコマンドで bootstrap script が inject される", async () => {
    const { view, evaluateMock } = createMockView(async () => 1);
    const bridge = setupBunMot(view, { port: 0 });
    await postCommand(bridge, { type: "evaluate", expression: "1" });
    const calls = evaluateMock.mock.calls;
    // 最初の呼び出しが bootstrap script
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const first = calls[0]?.[0] as string | undefined;
    expect(first).toBeDefined();
    expect(first ?? "").toContain("__BUNMOT_LOGS__");
    expect(first ?? "").toContain("MAX");
    bridge.stop();
  });

  test("2 回目のコマンドで bootstrap は再実行されず ensure script が呼ばれる", async () => {
    const { view, evaluateMock } = createMockView(async () => 1);
    const bridge = setupBunMot(view, { port: 0 });
    await postCommand(bridge, { type: "evaluate", expression: "1" });
    const callsAfterFirst = evaluateMock.mock.calls.length;
    await postCommand(bridge, { type: "evaluate", expression: "2" });
    const callsAfterSecond = evaluateMock.mock.calls.length;
    // 2 回目: ensure (1) + 実コマンド (1) = 2 増。bootstrap は呼ばれない。
    expect(callsAfterSecond - callsAfterFirst).toBe(2);
    // ensure script は !window.__BUNMOT_LOGS__ ガードを持つ
    const ensureCall = evaluateMock.mock.calls[callsAfterFirst]?.[0] as string | undefined;
    expect(ensureCall ?? "").toContain("!window.__BUNMOT_LOGS__");
    bridge.stop();
  });

  test("bootstrap 失敗時も他コマンドは継続実行できる", async () => {
    let callCount = 0;
    const view: BunMotView = {
      rpc: {
        request: {
          evaluateJavascriptWithResponse: async (script: string): Promise<unknown> => {
            callCount++;
            // bootstrap (= 最初の patch script) のみ reject。
            if (
              script.includes("__BUNMOT_LOGS__") &&
              script.includes("MAX") &&
              !script.includes("!window.__BUNMOT_LOGS__")
            ) {
              throw new Error("bootstrap failed");
            }
            return 99;
          },
        },
      },
    };
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "evaluate", expression: "1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; result: unknown };
    expect(body.success).toBe(true);
    expect(body.result).toBe(99);
    expect(callCount).toBeGreaterThan(0);
    bridge.stop();
  });

  test("bootstrap 失敗後の getLogs で patchMissing: true", async () => {
    const view: BunMotView = {
      rpc: {
        request: {
          evaluateJavascriptWithResponse: async (script: string): Promise<unknown> => {
            // bootstrap reject
            if (
              script.includes("MAX") &&
              !script.includes("!window.__BUNMOT_LOGS__")
            ) {
              throw new Error("bootstrap failed");
            }
            // getLogs では実 WebView 状態を模して patchMissing: true を返す
            if (script.includes("buf.drain")) {
              return { entries: [], droppedCount: 0, patchMissing: true };
            }
            return undefined;
          },
        },
      },
    };
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "getLogs" });
    const body = (await res.json()) as {
      success: boolean;
      result: { patchMissing: boolean };
    };
    expect(body.success).toBe(true);
    expect(body.result.patchMissing).toBe(true);
    bridge.stop();
  });
});

describe("ログフィールド (機密保護)", () => {
  test("fill の command_received は value を含まず valueLength のみ記録", async () => {
    // logger をスパイ: console.log の出力を捕捉する。
    process.env["BUN_MOT_LOG"] = "verbose";
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg: string): void => {
      captured.push(msg);
    };
    try {
      const { view } = createMockView(async (script: string) => {
        if (script.includes("dispatchEvent")) return { filled: true };
        return undefined;
      });
      const bridge = setupBunMot(view, { port: 0 });
      await postCommand(bridge, {
        type: "fill",
        selector: ".x",
        value: "secret-token-1234",
      });
      const fillReceived = captured.find(
        (l) => l.includes("command_received") && l.includes("type=fill"),
      );
      expect(fillReceived).toBeDefined();
      expect(fillReceived ?? "").not.toContain("secret-token-1234");
      expect(fillReceived ?? "").toContain("valueLength=17");
      bridge.stop();
    } finally {
      console.log = original;
      process.env["BUN_MOT_LOG"] = "silent";
    }
  });

  test("waitForText の command_received は text の中身を含まず textKind のみ記録", async () => {
    process.env["BUN_MOT_LOG"] = "verbose";
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg: string): void => {
      captured.push(msg);
    };
    try {
      const { view } = createMockView(async (script: string) => {
        if (script.includes("matched")) return { matched: true };
        return undefined;
      });
      const bridge = setupBunMot(view, { port: 0 });
      await postCommand(bridge, {
        type: "waitForText",
        selector: ".x",
        text: { kind: "string", value: "private-message-content" },
        timeout: 1000,
      });
      const received = captured.find(
        (l) => l.includes("command_received") && l.includes("type=waitForText"),
      );
      expect(received).toBeDefined();
      expect(received ?? "").not.toContain("private-message-content");
      expect(received ?? "").toContain("textKind=string");
      bridge.stop();
    } finally {
      console.log = original;
      process.env["BUN_MOT_LOG"] = "silent";
    }
  });
});
