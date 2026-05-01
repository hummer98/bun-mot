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
    expect(evaluateMock).toHaveBeenCalledTimes(1);
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
    // 生成された script に 5000 が埋め込まれている
    const calls = evaluateMock.mock.calls;
    expect(calls).toHaveLength(1);
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall) {
      expect(firstCall[0]).toContain("5000");
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
    const res = await postCommand(bridge, { type: "click", selector: ".x" });
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
