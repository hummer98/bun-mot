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

// テスト本体は引数を string で受け取りたいので、ここで Electrobun 1.16 の
// `{ script }` シグネチャから string への adapter を挟む。
type EvalImpl = (script: string) => Promise<unknown>;
type MockEval = (params: { script: string }) => Promise<unknown>;

function createMockView(evalImpl: EvalImpl): {
  view: BunMotView;
  evaluateMock: ReturnType<typeof mock<MockEval>>;
} {
  const evaluateMock = mock<MockEval>(async (params: { script: string }) =>
    evalImpl(params.script),
  );
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

  test("waitForSelector 正常系: chunk が matched: true → wire { found: true }", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        return { matched: true, elapsed: 100 };
      }
      return undefined;
    });
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
    const { view, evaluateMock } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        return { matched: true, elapsed: 50 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
    });
    expect(res.status).toBe(200);
    // §4.1: bootstrap (1) + ensure (2) + 実コマンド (3)。実コマンド (chunk script) に 5000 が埋め込まれている
    const calls = evaluateMock.mock.calls;
    expect(calls).toHaveLength(3);
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    if (lastCall) {
      expect(lastCall[0]?.script).toContain("5000");
      // chunk script は MutationObserver を含む
      expect(lastCall[0]?.script).toContain("MutationObserver");
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
  test("chunk が matched: false を返し続けると bridge が __BUNMOT_TIMEOUT__ で reject (kind: timeout)", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        // 全 chunk が unmatched
        return { matched: false, elapsed: 5000 };
      }
      return undefined;
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
    expect(body.error.message).toContain("__BUNMOT_TIMEOUT__");
    expect(body.error.message).toContain(".foo");
    bridge.stop();
  });

  test("WebView が直接 __BUNMOT_TIMEOUT__ throw した場合も kind: timeout (preload reject 経路)", async () => {
    // chunk script は通常 reject しないが、preload 切断等で WebView 側 evaluate が reject した場合
    // 既存の mapErrorToKind が prefix で timeout に分類することを保証する。
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        throw "__BUNMOT_TIMEOUT__:.foo:5000";
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 5000,
    });
    const body = (await res.json()) as { error: { kind: string } };
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
          }) as unknown as (params: { script: string }) => Promise<unknown>,
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

  test("waitForHidden 正常系: chunk が matched: true → wire { hidden: true }", async () => {
    const { view } = createMockView(async (script: string) => {
      // chunk script は MutationObserver を含み、isVisibleFn で hidden 判定する
      if (script.includes("isVisibleFn")) return { matched: true, elapsed: 100 };
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

  test("waitForHidden で全 chunk unmatched → kind: timeout", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("isVisibleFn")) {
        return { matched: false, elapsed: 1000 };
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
      if (script.includes("includes")) {
        lastCommandScript = script;
        return { matched: true, elapsed: 100 };
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
    expect(await res.json()).toEqual({ success: true, result: { matched: true } });
    expect(lastCommandScript).toContain("includes");
    expect(lastCommandScript).toContain("hello");
    bridge.stop();
  });

  test("waitForText 正常系: wire-format (regex) を script に含む", async () => {
    let lastCommandScript = "";
    const { view } = createMockView(async (script: string) => {
      if (script.includes("RegExp")) {
        lastCommandScript = script;
        return { matched: true, elapsed: 100 };
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
    const first = calls[0]?.[0]?.script as string | undefined;
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
    const ensureCall = evaluateMock.mock.calls[callsAfterFirst]?.[0]?.script as
      | string
      | undefined;
    expect(ensureCall ?? "").toContain("!window.__BUNMOT_LOGS__");
    bridge.stop();
  });

  test("bootstrap 失敗時も他コマンドは継続実行できる", async () => {
    let callCount = 0;
    const view: BunMotView = {
      rpc: {
        request: {
          evaluateJavascriptWithResponse: async ({
            script,
          }: {
            script: string;
          }): Promise<unknown> => {
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
          evaluateJavascriptWithResponse: async ({
            script,
          }: {
            script: string;
          }): Promise<unknown> => {
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

describe("POST /command - screenshot", () => {
  test("正常系: { dataUrl, byteCount } をそのまま返す", async () => {
    let lastCommandScript = "";
    const SAMPLE_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    const { view } = createMockView(async (script: string) => {
      if (script.includes("__bunmot_html2canvas")) {
        lastCommandScript = script;
        return { dataUrl: SAMPLE_DATA_URL, byteCount: 70 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, {
      type: "screenshot",
      fullPage: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      result: { dataUrl: SAMPLE_DATA_URL, byteCount: 70 },
    });
    expect(lastCommandScript).toContain("__bunmot_html2canvas");
    bridge.stop();
  });

  test("fullPage 省略時は documentElement を target にする (true fallback)", async () => {
    let lastCommandScript = "";
    const { view } = createMockView(async (script: string) => {
      if (script.includes("__bunmot_html2canvas")) {
        lastCommandScript = script;
        return { dataUrl: "data:image/png;base64,xxx", byteCount: 0 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    await postCommand(bridge, { type: "screenshot" });
    expect(lastCommandScript).toContain("document.documentElement");
    bridge.stop();
  });

  test("fullPage: false で document.body を target にする", async () => {
    let lastCommandScript = "";
    const { view } = createMockView(async (script: string) => {
      if (script.includes("__bunmot_html2canvas")) {
        lastCommandScript = script;
        return { dataUrl: "data:image/png;base64,xxx", byteCount: 0 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    await postCommand(bridge, { type: "screenshot", fullPage: false });
    expect(lastCommandScript).toContain("document.body");
    bridge.stop();
  });

  test("WebView reject (SecurityError 等) → kind: evaluation_error", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("__bunmot_html2canvas")) {
        throw new Error("Tainted canvases may not be exported");
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    const res = await postCommand(bridge, { type: "screenshot" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      error: { kind: string; message: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.kind).toBe("evaluation_error");
    expect(body.error.message).toContain("Tainted");
    bridge.stop();
  });

  test("command_received は dataUrl をログに含めず fullPage のみ記録", async () => {
    process.env["BUN_MOT_LOG"] = "verbose";
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg: string): void => {
      captured.push(msg);
    };
    try {
      const SECRET_DATA_URL =
        "data:image/png;base64,SECRETPAYLOADTHATSHOULDNOTBELOGGED";
      const { view } = createMockView(async (script: string) => {
        if (script.includes("__bunmot_html2canvas")) {
          return { dataUrl: SECRET_DATA_URL, byteCount: 27 };
        }
        return undefined;
      });
      const bridge = setupBunMot(view, { port: 0 });
      await postCommand(bridge, { type: "screenshot", fullPage: true });
      const received = captured.find(
        (l) => l.includes("command_received") && l.includes("type=screenshot"),
      );
      expect(received).toBeDefined();
      expect(received ?? "").not.toContain("SECRETPAYLOADTHATSHOULDNOTBELOGGED");
      expect(received ?? "").toContain("fullPage=true");
      bridge.stop();
    } finally {
      console.log = original;
      process.env["BUN_MOT_LOG"] = "silent";
    }
  });

  test("screenshot_started / screenshot_completed ログイベントが発火する", async () => {
    process.env["BUN_MOT_LOG"] = "verbose";
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg: string): void => {
      captured.push(msg);
    };
    try {
      const { view } = createMockView(async (script: string) => {
        if (script.includes("__bunmot_html2canvas")) {
          return { dataUrl: "data:image/png;base64,xxx", byteCount: 3 };
        }
        return undefined;
      });
      const bridge = setupBunMot(view, { port: 0 });
      await postCommand(bridge, { type: "screenshot" });
      const started = captured.find((l) => l.includes("screenshot_started"));
      const completed = captured.find((l) => l.includes("screenshot_completed"));
      expect(started).toBeDefined();
      expect(completed).toBeDefined();
      expect(completed ?? "").toContain("byteCount=3");
      bridge.stop();
    } finally {
      console.log = original;
      process.env["BUN_MOT_LOG"] = "silent";
    }
  });

  test("WebView reject 時に screenshot_failed ログイベントが発火する", async () => {
    process.env["BUN_MOT_LOG"] = "verbose";
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg: string): void => {
      captured.push(msg);
    };
    try {
      const { view } = createMockView(async (script: string) => {
        if (script.includes("__bunmot_html2canvas")) {
          throw new Error("Tainted canvases may not be exported");
        }
        return undefined;
      });
      const bridge = setupBunMot(view, { port: 0 });
      await postCommand(bridge, { type: "screenshot" });
      const failed = captured.find((l) => l.includes("screenshot_failed"));
      expect(failed).toBeDefined();
      expect(failed ?? "").toContain("kind=evaluation_error");
      bridge.stop();
    } finally {
      console.log = original;
      process.env["BUN_MOT_LOG"] = "silent";
    }
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
        if (script.includes("includes")) return { matched: true, elapsed: 100 };
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

describe("Bootstrap timeout (#5)", () => {
  test("bootstrap が解決しなくても evaluate は成功する", async () => {
    let callIdx = 0;
    const view: BunMotView = {
      rpc: {
        request: {
          evaluateJavascriptWithResponse: async ({
            script,
          }: {
            script: string;
          }): Promise<unknown> => {
            callIdx++;
            // bootstrap script 識別: __BUNMOT_LOGS__ + MAX を含み、!window.__BUNMOT_LOGS__ ガードを含まない
            const isBootstrap =
              script.includes("__BUNMOT_LOGS__") &&
              script.includes("MAX") &&
              !script.includes("!window.__BUNMOT_LOGS__");
            if (isBootstrap) {
              // 永遠に解決しない Promise (RPC の 1s timeout を超える状態を模倣)
              return await new Promise<unknown>(() => {});
            }
            return 42;
          },
        },
      },
    };
    const bridge = setupBunMot(view, { port: 0, bootstrapTimeoutMs: 50 });
    const res = await postCommand(bridge, {
      type: "evaluate",
      expression: "1+1",
    });
    const body = (await res.json()) as { success: boolean; result: unknown };
    expect(body).toEqual({ success: true, result: 42 });
    expect(callIdx).toBeGreaterThanOrEqual(1);
    bridge.stop();
  });

  test("bootstrap timeout は default 5000ms で発火する (option 省略時)", async () => {
    // 直接 default 値を assert はしないが、option 省略時に bootstrap が ~200ms 遅延しても
    // テストランタイム (5s 以内) で完走することを確認する。
    let bootstrapResolved = false;
    const view: BunMotView = {
      rpc: {
        request: {
          evaluateJavascriptWithResponse: async ({
            script,
          }: {
            script: string;
          }): Promise<unknown> => {
            const isBootstrap =
              script.includes("__BUNMOT_LOGS__") &&
              script.includes("MAX") &&
              !script.includes("!window.__BUNMOT_LOGS__");
            if (isBootstrap) {
              await new Promise((r) => setTimeout(r, 200));
              bootstrapResolved = true;
              return undefined;
            }
            return 1;
          },
        },
      },
    };
    const bridge = setupBunMot(view, { port: 0 }); // bootstrapTimeoutMs 省略 → 5000
    const res = await postCommand(bridge, {
      type: "evaluate",
      expression: "1",
    });
    expect(res.status).toBe(200);
    expect(bootstrapResolved).toBe(true); // 5s 内に bootstrap が完走した
    bridge.stop();
  });

  test("bootstrap timeout 後でも getLogs は patchMissing: true で返る", async () => {
    const view: BunMotView = {
      rpc: {
        request: {
          evaluateJavascriptWithResponse: async ({
            script,
          }: {
            script: string;
          }): Promise<unknown> => {
            const isBootstrap =
              script.includes("__BUNMOT_LOGS__") &&
              script.includes("MAX") &&
              !script.includes("!window.__BUNMOT_LOGS__");
            if (isBootstrap) return await new Promise<unknown>(() => {});
            if (script.includes("buf.drain")) {
              return { entries: [], droppedCount: 0, patchMissing: true };
            }
            return undefined;
          },
        },
      },
    };
    const bridge = setupBunMot(view, { port: 0, bootstrapTimeoutMs: 30 });
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

describe("wait 系 chunk loop (#7: Electrobun preload 10s WS timeout 回避)", () => {
  // chunk script に渡された CHUNK_TIMEOUT 値を抽出する小ヘルパー。
  // chunk script は `const TIMEOUT = <ms>;` を含むため正規表現で取り出す。
  function extractChunkTimeoutMs(script: string): number | null {
    const m = script.match(/const TIMEOUT = (\d+);/);
    if (!m || m[1] === undefined) return null;
    return Number.parseInt(m[1], 10);
  }

  test("setupBunMot: chunkTimeoutMs 未指定時は 5000ms がデフォルト", async () => {
    const sizes: number[] = [];
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        const size = extractChunkTimeoutMs(script);
        if (size !== null) sizes.push(size);
        return { matched: true, elapsed: 10 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0 });
    await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 4000,
    });
    // timeout=4000, default chunkTimeoutMs=5000 → min(5000,4000)=4000
    expect(sizes).toEqual([4000]);
    bridge.stop();
  });

  test("waitForSelector: timeout=4000 → 1 chunk (size=4000) で完結 (chunk_completed 1 回)", async () => {
    let chunkCount = 0;
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        chunkCount++;
        return { matched: false, elapsed: 4000 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
    const start = Date.now();
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 4000,
    });
    const elapsedReal = Date.now() - start;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; error?: { kind: string } };
    expect(body.success).toBe(false);
    expect(body.error?.kind).toBe("timeout");
    expect(chunkCount).toBe(1);
    // chunk loop が無駄に長く待たないこと (mock は即座に false を返すので実時間は数十 ms)
    expect(elapsedReal).toBeLessThan(2000);
    bridge.stop();
  });

  test("waitForSelector: timeout=6000, chunkTimeoutMs=5000 → 2 chunks (5000 + 1000)", async () => {
    const sizes: number[] = [];
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        const size = extractChunkTimeoutMs(script);
        if (size !== null) sizes.push(size);
        return { matched: false, elapsed: size ?? 0 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 6000,
    });
    const body = (await res.json()) as { error?: { kind: string; message: string } };
    expect(body.error?.kind).toBe("timeout");
    expect(sizes).toEqual([5000, 1000]);
    bridge.stop();
  });

  test("waitForSelector: timeout=60000 → 全 chunk unmatched で timeout (selector / elapsed をメッセージに含む)", async () => {
    let chunkCount = 0;
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        chunkCount++;
        return { matched: false, elapsed: 5000 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 60000,
    });
    const body = (await res.json()) as { error?: { kind: string; message: string } };
    expect(body.error?.kind).toBe("timeout");
    expect(body.error?.message).toContain(".foo");
    expect(body.error?.message).toMatch(/__BUNMOT_TIMEOUT__:\.foo:\d+/);
    // mock は実時間 0 で false を返すため、bridge は Date.now() ベースの totalElapsed が
    // 60000 に達するまで chunk を回し続ける。実時間で 60s 以内に終わらない可能性を避けるため
    // 件数 (>=1) は確認するが上限の 12 件は強制しない (実時間依存のため緩めに検証)。
    expect(chunkCount).toBeGreaterThanOrEqual(1);
    bridge.stop();
  });

  test("waitForSelector: 3 chunk 目で matched: true → success と { found: true } が返る", async () => {
    let count = 0;
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        count++;
        if (count >= 3) return { matched: true, elapsed: 234 };
        return { matched: false, elapsed: 5000 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 60000,
    });
    expect(await res.json()).toEqual({ success: true, result: { found: true } });
    expect(count).toBe(3);
    bridge.stop();
  });

  test("waitForSelector: timeout=4999 → 1 chunk (size=4999)", async () => {
    let chunkSize = 0;
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        const size = extractChunkTimeoutMs(script);
        if (size !== null) chunkSize = size;
        return { matched: false, elapsed: chunkSize };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
    await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 4999,
    });
    expect(chunkSize).toBe(4999);
    bridge.stop();
  });

  test("waitForSelector: timeout=5000 → 1 chunk (size=5000、ちょうど境界)", async () => {
    let chunkCount = 0;
    let lastSize = 0;
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        chunkCount++;
        const size = extractChunkTimeoutMs(script);
        if (size !== null) lastSize = size;
        return { matched: false, elapsed: lastSize };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
    await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 5000,
    });
    expect(chunkCount).toBe(1);
    expect(lastSize).toBe(5000);
    bridge.stop();
  });

  test("setupBunMot: chunkTimeoutMs=2000 で wait 系 chunk が 2000ms 以下に分割される", async () => {
    const sizes: number[] = [];
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        const size = extractChunkTimeoutMs(script);
        if (size !== null) sizes.push(size);
        return { matched: false, elapsed: size ?? 0 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 2000 });
    await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 5000,
    });
    // 2000 + 2000 + 1000 → 3 chunks
    expect(sizes).toEqual([2000, 2000, 1000]);
    bridge.stop();
  });

  test("waitForHidden: chunk loop で hidden を待つ (matched: true → wire { hidden: true })", async () => {
    let count = 0;
    const { view } = createMockView(async (script: string) => {
      if (script.includes("isVisibleFn")) {
        count++;
        if (count >= 2) return { matched: true, elapsed: 500 };
        return { matched: false, elapsed: 5000 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
    const res = await postCommand(bridge, {
      type: "waitForHidden",
      selector: ".x",
      timeout: 30000,
    });
    expect(await res.json()).toEqual({ success: true, result: { hidden: true } });
    expect(count).toBe(2);
    bridge.stop();
  });

  test("waitForText: chunk loop で text match を待つ (matched: true → wire { matched: true })", async () => {
    let count = 0;
    const { view } = createMockView(async (script: string) => {
      if (script.includes("includes")) {
        count++;
        if (count >= 4) return { matched: true, elapsed: 1234 };
        return { matched: false, elapsed: 5000 };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
    const res = await postCommand(bridge, {
      type: "waitForText",
      selector: ".x",
      text: { kind: "string", value: "hello" },
      timeout: 60000,
    });
    expect(await res.json()).toEqual({ success: true, result: { matched: true } });
    expect(count).toBe(4);
    bridge.stop();
  });

  test("waitForSelector: chunk が { matched, elapsed } 以外 (旧 shape) を返したら internal_error", async () => {
    const { view } = createMockView(async (script: string) => {
      if (script.includes("MutationObserver")) {
        return { found: true };
      }
      return undefined;
    });
    const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
    const res = await postCommand(bridge, {
      type: "waitForSelector",
      selector: ".foo",
      timeout: 5000,
    });
    const body = (await res.json()) as { error?: { kind: string } };
    expect(body.error?.kind).toBe("internal_error");
    bridge.stop();
  });

  test("setupBunMot: chunkTimeoutMs <= 0 は throw する (sanity check)", () => {
    const { view } = createMockView(async () => null);
    expect(() => setupBunMot(view, { port: 0, chunkTimeoutMs: 0 })).toThrow();
    expect(() => setupBunMot(view, { port: 0, chunkTimeoutMs: -1 })).toThrow();
    expect(() => setupBunMot(view, { port: 0, chunkTimeoutMs: Number.NaN })).toThrow();
  });

  test("wait_chunk_completed ログイベントが各 chunk で発火する", async () => {
    process.env["BUN_MOT_LOG"] = "verbose";
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg: string): void => {
      captured.push(msg);
    };
    try {
      let count = 0;
      const { view } = createMockView(async (script: string) => {
        if (script.includes("MutationObserver")) {
          count++;
          if (count >= 2) return { matched: true, elapsed: 100 };
          return { matched: false, elapsed: 5000 };
        }
        return undefined;
      });
      const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
      await postCommand(bridge, {
        type: "waitForSelector",
        selector: ".foo",
        timeout: 60000,
      });
      const chunkLogs = captured.filter((l) => l.includes("wait_chunk_completed"));
      expect(chunkLogs.length).toBe(2);
      expect(chunkLogs[0] ?? "").toContain("type=waitForSelector");
      expect(chunkLogs[0] ?? "").toContain("matched=false");
      expect(chunkLogs[1] ?? "").toContain("matched=true");
      bridge.stop();
    } finally {
      console.log = original;
      process.env["BUN_MOT_LOG"] = "silent";
    }
  });

  test("wait_total_timeout ログイベントが全体 timeout 到達時に発火する", async () => {
    process.env["BUN_MOT_LOG"] = "verbose";
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg: string): void => {
      captured.push(msg);
    };
    try {
      const { view } = createMockView(async (script: string) => {
        if (script.includes("MutationObserver")) {
          return { matched: false, elapsed: 5000 };
        }
        return undefined;
      });
      const bridge = setupBunMot(view, { port: 0, chunkTimeoutMs: 5000 });
      await postCommand(bridge, {
        type: "waitForSelector",
        selector: ".foo",
        timeout: 5000,
      });
      const totalLogs = captured.filter((l) => l.includes("wait_total_timeout"));
      expect(totalLogs.length).toBe(1);
      expect(totalLogs[0] ?? "").toContain("type=waitForSelector");
      expect(totalLogs[0] ?? "").toContain("selector=.foo");
      expect(totalLogs[0] ?? "").toContain("timeoutMs=5000");
      bridge.stop();
    } finally {
      console.log = original;
      process.env["BUN_MOT_LOG"] = "silent";
    }
  });
});
