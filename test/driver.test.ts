import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { setupBunMot } from "../src/bridge";
import { BunMot } from "../src/driver";
import type { BunMotView, ConsoleLogEntry } from "../src/types";
import {
  BunMotError,
  BunMotElementNotInteractableError,
  BunMotSelectorNotFoundError,
  BunMotTimeoutError,
} from "../src/errors";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeAll(() => {
  process.env["BUN_MOT_LOG"] = "silent";
});
afterAll(() => {
  delete process.env["BUN_MOT_LOG"];
});

type EvalImpl = (script: string) => Promise<unknown>;
type CapturedRequest = {
  type: string;
  expression?: string;
  selector?: string;
  timeout?: number;
  viewId?: string;
  value?: string;
  attribute?: string;
  text?: { kind: string; value?: string; source?: string; flags?: string };
  fullPage?: boolean;
};

interface BridgeHarness {
  port: number;
  evalMock: ReturnType<typeof mock<EvalImpl>>;
  receivedRequests: CapturedRequest[];
  stop: () => void;
}

type ResponseImpl =
  | { success: true; result: unknown }
  | { success: false; error: { kind: string; message: string } };

// driver から bridge に届いた request body を捕捉するため、
// 独立した capturing server を立てて driver の HTTP を受ける。
async function startCapturingBridge(
  evalImpl: EvalImpl,
  responseFor?: (req: CapturedRequest) => ResponseImpl | undefined,
): Promise<BridgeHarness> {
  const evalMock = mock(evalImpl);
  const view: BunMotView = {
    rpc: { request: { evaluateJavascriptWithResponse: evalMock } },
  };
  void view;
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname !== "/command" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as CapturedRequest;
      requests.push(body);
      const overridden = responseFor?.(body);
      if (overridden !== undefined) {
        return new Response(JSON.stringify(overridden), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        const result = await evalMock("dummy");
        return new Response(JSON.stringify({ success: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({
            success: false,
            error: { kind: "evaluation_error", message: e instanceof Error ? e.message : String(e) },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    },
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("Bun.serve did not return a port");
  }
  return {
    port,
    evalMock,
    receivedRequests: requests,
    stop: (): void => {
      server.stop(true);
    },
  };
}

describe("BunMot.evaluate", () => {
  test("evaluate を呼ぶと bridge に { type: 'evaluate', expression } が届く", async () => {
    const harness = await startCapturingBridge(async () => 42);
    const mot = new BunMot({ port: harness.port });
    const result = await mot.evaluate("1+1");
    expect(result).toBe(42);
    expect(harness.receivedRequests).toHaveLength(1);
    expect(harness.receivedRequests[0]).toMatchObject({
      type: "evaluate",
      expression: "1+1",
    });
    harness.stop();
  });
});

describe("BunMot.waitForSelector", () => {
  test("defaultTimeout (5000) が request body に含まれる", async () => {
    const harness = await startCapturingBridge(async () => ({ found: true }));
    const mot = new BunMot({ port: harness.port });
    await mot.waitForSelector(".foo");
    expect(harness.receivedRequests[0]).toMatchObject({
      type: "waitForSelector",
      selector: ".foo",
      timeout: 5000,
    });
    harness.stop();
  });

  test("options.timeout が defaultTimeout を上書きする", async () => {
    const harness = await startCapturingBridge(async () => ({ found: true }));
    const mot = new BunMot({ port: harness.port });
    await mot.waitForSelector(".foo", { timeout: 1000 });
    expect(harness.receivedRequests[0]?.timeout).toBe(1000);
    harness.stop();
  });

  test("constructor の defaultTimeout が反映される", async () => {
    const harness = await startCapturingBridge(async () => ({ found: true }));
    const mot = new BunMot({ port: harness.port, defaultTimeout: 9999 });
    await mot.waitForSelector(".foo");
    expect(harness.receivedRequests[0]?.timeout).toBe(9999);
    harness.stop();
  });

  test("予期せぬ shape のレスポンスで BunMotError(internal_error) が throw される", async () => {
    // bridge が { foo: "bar" } を result として返すケース
    const harness = await startCapturingBridge(async () => ({ foo: "bar" }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.waitForSelector(".foo");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotError);
    if (caught instanceof BunMotError) {
      expect(caught.kind).toBe("internal_error");
    }
    harness.stop();
  });
});

describe("BunMot.getText", () => {
  test("{ text: string } から string を取り出して返す", async () => {
    const harness = await startCapturingBridge(async () => ({ text: "hello" }));
    const mot = new BunMot({ port: harness.port });
    const text = await mot.getText("h1");
    expect(text).toBe("hello");
    harness.stop();
  });

  test("予期せぬ shape のレスポンスで BunMotError(internal_error) が throw される", async () => {
    const harness = await startCapturingBridge(async () => ({ wrong: 1 }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.getText("h1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotError);
    if (caught instanceof BunMotError) {
      expect(caught.kind).toBe("internal_error");
    }
    harness.stop();
  });
});

describe("BunMot - viewId 自動付与", () => {
  test("viewId 指定時、evaluate の request body に viewId が含まれる", async () => {
    const harness = await startCapturingBridge(async () => 1);
    const mot = new BunMot({ port: harness.port, viewId: "main" });
    await mot.evaluate("1+1");
    expect(harness.receivedRequests[0]?.viewId).toBe("main");
    harness.stop();
  });

  test("viewId 指定時、waitForSelector の request body に viewId が含まれる", async () => {
    const harness = await startCapturingBridge(async () => ({ found: true }));
    const mot = new BunMot({ port: harness.port, viewId: "secondary" });
    await mot.waitForSelector(".x");
    expect(harness.receivedRequests[0]?.viewId).toBe("secondary");
    harness.stop();
  });

  test("viewId 指定時、getText の request body に viewId が含まれる", async () => {
    const harness = await startCapturingBridge(async () => ({ text: "x" }));
    const mot = new BunMot({ port: harness.port, viewId: "tertiary" });
    await mot.getText("h1");
    expect(harness.receivedRequests[0]?.viewId).toBe("tertiary");
    harness.stop();
  });

  test("viewId 未指定時、request body に viewId が含まれない (undefined)", async () => {
    const harness = await startCapturingBridge(async () => 1);
    const mot = new BunMot({ port: harness.port });
    await mot.evaluate("1+1");
    expect(harness.receivedRequests[0]?.viewId).toBeUndefined();
    harness.stop();
  });
});

describe("BunMot - end-to-end with bridge", () => {
  test("setupBunMot + BunMot で evaluate が通る", async () => {
    const view: BunMotView = {
      rpc: {
        request: {
          evaluateJavascriptWithResponse: async () => "ok",
        },
      },
    };
    const bridge = setupBunMot(view, { port: 0 });
    const mot = new BunMot({ port: bridge.port });
    const result = await mot.evaluate("'ok'");
    expect(result).toBe("ok");
    bridge.stop();
  });
});

describe("BunMot.click", () => {
  test("click を呼ぶと bridge に { type: 'click', selector } が届く", async () => {
    const harness = await startCapturingBridge(async () => ({ clicked: true }));
    const mot = new BunMot({ port: harness.port });
    await mot.click(".btn");
    expect(harness.receivedRequests[0]).toMatchObject({
      type: "click",
      selector: ".btn",
    });
    harness.stop();
  });

  test("element_not_interactable kind で BunMotElementNotInteractableError", async () => {
    const harness = await startCapturingBridge(async () => null, () => ({
      success: false,
      error: {
        kind: "element_not_interactable",
        message: "__BUNMOT_NOT_INTERACTABLE__:.btn:not_html_element",
      },
    }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.click(".btn");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotElementNotInteractableError);
    if (caught instanceof BunMotElementNotInteractableError) {
      expect(caught.selector).toBe(".btn");
      expect(caught.reason).toBe("not_html_element");
    }
    harness.stop();
  });

  test("selector_not_found kind で BunMotSelectorNotFoundError", async () => {
    const harness = await startCapturingBridge(async () => null, () => ({
      success: false,
      error: {
        kind: "selector_not_found",
        message: "__BUNMOT_SELECTOR_NOT_FOUND__:.btn",
      },
    }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.click(".btn");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotSelectorNotFoundError);
    harness.stop();
  });

  test("予期せぬ shape で BunMotError(internal_error)", async () => {
    const harness = await startCapturingBridge(async () => ({ wrong: 1 }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.click(".btn");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotError);
    if (caught instanceof BunMotError) {
      expect(caught.kind).toBe("internal_error");
    }
    harness.stop();
  });
});

describe("BunMot.fill", () => {
  test("value が request body に含まれる", async () => {
    const harness = await startCapturingBridge(async () => ({ filled: true }));
    const mot = new BunMot({ port: harness.port });
    await mot.fill(".input", "hello");
    expect(harness.receivedRequests[0]).toMatchObject({
      type: "fill",
      selector: ".input",
      value: "hello",
    });
    harness.stop();
  });

  test("element_not_interactable で BunMotElementNotInteractableError", async () => {
    const harness = await startCapturingBridge(async () => null, () => ({
      success: false,
      error: {
        kind: "element_not_interactable",
        message: "__BUNMOT_NOT_INTERACTABLE__:.x:not_input_or_textarea",
      },
    }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.fill(".x", "v");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotElementNotInteractableError);
    if (caught instanceof BunMotElementNotInteractableError) {
      expect(caught.reason).toBe("not_input_or_textarea");
    }
    harness.stop();
  });
});

describe("BunMot.waitForHidden", () => {
  test("defaultTimeout が反映される", async () => {
    const harness = await startCapturingBridge(async () => ({ hidden: true }));
    const mot = new BunMot({ port: harness.port });
    await mot.waitForHidden(".x");
    expect(harness.receivedRequests[0]).toMatchObject({
      type: "waitForHidden",
      selector: ".x",
      timeout: 5000,
    });
    harness.stop();
  });

  test("options.timeout が上書きする", async () => {
    const harness = await startCapturingBridge(async () => ({ hidden: true }));
    const mot = new BunMot({ port: harness.port });
    await mot.waitForHidden(".x", { timeout: 1234 });
    expect(harness.receivedRequests[0]?.timeout).toBe(1234);
    harness.stop();
  });

  test("timeout で BunMotTimeoutError (waitForHidden 用メッセージ)", async () => {
    const harness = await startCapturingBridge(async () => null, () => ({
      success: false,
      error: { kind: "timeout", message: "__BUNMOT_TIMEOUT__:.x:1000" },
    }));
    const mot = new BunMot({ port: harness.port, defaultTimeout: 1000 });
    let caught: unknown;
    try {
      await mot.waitForHidden(".x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotTimeoutError);
    if (caught instanceof BunMotTimeoutError) {
      expect(caught.commandLabel).toBe("waitForHidden");
      expect(caught.message).toContain("waitForHidden timeout");
      expect(caught.message).toContain("still visible");
    }
    harness.stop();
  });
});

describe("BunMot.waitForText", () => {
  test("string text → wire-format { kind: 'string', value }", async () => {
    const harness = await startCapturingBridge(async () => ({ matched: true }));
    const mot = new BunMot({ port: harness.port });
    await mot.waitForText(".x", "hello");
    expect(harness.receivedRequests[0]?.text).toEqual({
      kind: "string",
      value: "hello",
    });
    harness.stop();
  });

  test("RegExp → wire-format { kind: 'regex', source, flags }", async () => {
    const harness = await startCapturingBridge(async () => ({ matched: true }));
    const mot = new BunMot({ port: harness.port });
    await mot.waitForText(".x", /h.+/i);
    expect(harness.receivedRequests[0]?.text).toEqual({
      kind: "regex",
      source: "h.+",
      flags: "i",
    });
    harness.stop();
  });

  test("timeout で BunMotTimeoutError (expectedText 復元 / string)", async () => {
    const harness = await startCapturingBridge(async () => null, () => ({
      success: false,
      error: { kind: "timeout", message: "__BUNMOT_TIMEOUT__:.x:1000" },
    }));
    const mot = new BunMot({ port: harness.port, defaultTimeout: 1000 });
    let caught: unknown;
    try {
      await mot.waitForText(".x", "expected-text");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotTimeoutError);
    if (caught instanceof BunMotTimeoutError) {
      expect(caught.commandLabel).toBe("waitForText");
      expect(caught.expectedText).toBe("expected-text");
      expect(caught.message).toContain('"expected-text"');
    }
    harness.stop();
  });

  test("timeout で expectedText が /source/flags 形式で復元される (regex)", async () => {
    const harness = await startCapturingBridge(async () => null, () => ({
      success: false,
      error: { kind: "timeout", message: "__BUNMOT_TIMEOUT__:.x:500" },
    }));
    const mot = new BunMot({ port: harness.port, defaultTimeout: 500 });
    let caught: unknown;
    try {
      await mot.waitForText(".x", /h.+/i);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotTimeoutError);
    if (caught instanceof BunMotTimeoutError) {
      expect(caught.expectedText).toBe("/h.+/i");
    }
    harness.stop();
  });
});

describe("BunMot.isVisible", () => {
  test("boolean を返す (true)", async () => {
    const harness = await startCapturingBridge(async () => ({ visible: true }));
    const mot = new BunMot({ port: harness.port });
    expect(await mot.isVisible(".x")).toBe(true);
    harness.stop();
  });

  test("boolean を返す (false)", async () => {
    const harness = await startCapturingBridge(async () => ({ visible: false }));
    const mot = new BunMot({ port: harness.port });
    expect(await mot.isVisible(".x")).toBe(false);
    harness.stop();
  });

  test("予期せぬ shape で internal_error", async () => {
    const harness = await startCapturingBridge(async () => ({ visible: 1 }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.isVisible(".x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotError);
    harness.stop();
  });
});

describe("BunMot.getAttribute", () => {
  test("string を返す", async () => {
    const harness = await startCapturingBridge(async () => ({ value: "abc" }));
    const mot = new BunMot({ port: harness.port });
    expect(await mot.getAttribute(".x", "data-id")).toBe("abc");
    expect(harness.receivedRequests[0]).toMatchObject({
      type: "getAttribute",
      selector: ".x",
      attribute: "data-id",
    });
    harness.stop();
  });

  test("属性なし → null", async () => {
    const harness = await startCapturingBridge(async () => ({ value: null }));
    const mot = new BunMot({ port: harness.port });
    expect(await mot.getAttribute(".x", "data-id")).toBeNull();
    harness.stop();
  });
});

describe("BunMot.getLogs", () => {
  test("entries をそのまま返す (drop なし / patch あり)", async () => {
    const entries: ConsoleLogEntry[] = [
      { level: "log", message: "hi", timestamp: 100 },
      { level: "warn", message: "uh", timestamp: 200 },
    ];
    const harness = await startCapturingBridge(async () => ({
      entries,
      droppedCount: 0,
      patchMissing: false,
    }));
    const mot = new BunMot({ port: harness.port });
    const logs = await mot.getLogs();
    expect(logs).toEqual(entries);
    harness.stop();
  });

  test("droppedCount > 0 で先頭に warn entry を挿入", async () => {
    const entries: ConsoleLogEntry[] = [
      { level: "log", message: "after-drop", timestamp: 100 },
    ];
    const harness = await startCapturingBridge(async () => ({
      entries,
      droppedCount: 5,
      patchMissing: false,
    }));
    const mot = new BunMot({ port: harness.port });
    const logs = await mot.getLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0]?.level).toBe("warn");
    expect(logs[0]?.message).toContain("dropped 5");
    expect(logs[1]).toEqual(entries[0]!);
    harness.stop();
  });

  test("patchMissing: true → warn entry 単体配列", async () => {
    const harness = await startCapturingBridge(async () => ({
      entries: [],
      droppedCount: 0,
      patchMissing: true,
    }));
    const mot = new BunMot({ port: harness.port });
    const logs = await mot.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("warn");
    expect(logs[0]?.message).toContain("console patch was not active");
    harness.stop();
  });

  test("予期せぬ shape で internal_error", async () => {
    const harness = await startCapturingBridge(async () => ({ wrong: 1 }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.getLogs();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotError);
    if (caught instanceof BunMotError) {
      expect(caught.kind).toBe("internal_error");
    }
    harness.stop();
  });
});

describe("BunMot - 新コマンドでも viewId が伝搬される", () => {
  test("click", async () => {
    const harness = await startCapturingBridge(async () => ({ clicked: true }));
    const mot = new BunMot({ port: harness.port, viewId: "v1" });
    await mot.click(".btn");
    expect(harness.receivedRequests[0]?.viewId).toBe("v1");
    harness.stop();
  });

  test("waitForText", async () => {
    const harness = await startCapturingBridge(async () => ({ matched: true }));
    const mot = new BunMot({ port: harness.port, viewId: "v2" });
    await mot.waitForText(".x", "hi");
    expect(harness.receivedRequests[0]?.viewId).toBe("v2");
    harness.stop();
  });

  test("getLogs", async () => {
    const harness = await startCapturingBridge(async () => ({
      entries: [],
      droppedCount: 0,
      patchMissing: false,
    }));
    const mot = new BunMot({ port: harness.port, viewId: "v3" });
    await mot.getLogs();
    expect(harness.receivedRequests[0]?.viewId).toBe("v3");
    harness.stop();
  });
});

describe("BunMot.screenshot", () => {
  // 1×1 red pixel PNG (base64)。bridge mock が返す既知の有効な dataURL。
  const SAMPLE_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
  const SAMPLE_DATA_URL = `data:image/png;base64,${SAMPLE_PNG_BASE64}`;
  // PNG の magic number (89 50 4E 47)
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  test("path 省略時: { buffer, byteCount } を返す。buffer は PNG signature を持つ", async () => {
    const harness = await startCapturingBridge(async () => ({
      dataUrl: SAMPLE_DATA_URL,
      byteCount: 70,
    }));
    const mot = new BunMot({ port: harness.port });
    const result = await mot.screenshot();
    if ("buffer" in result) {
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.buffer.byteLength).toBe(result.byteCount);
      expect(result.buffer.subarray(0, 4)).toEqual(PNG_SIGNATURE);
    } else {
      throw new Error("expected { buffer, byteCount } result");
    }
    expect(harness.receivedRequests[0]).toMatchObject({
      type: "screenshot",
      fullPage: true,
    });
    harness.stop();
  });

  test("path 指定時: ファイルに書き出して { path, byteCount } を返す", async () => {
    const harness = await startCapturingBridge(async () => ({
      dataUrl: SAMPLE_DATA_URL,
      byteCount: 70,
    }));
    const mot = new BunMot({ port: harness.port });
    const path = join(
      tmpdir(),
      `bun-mot-screenshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
    try {
      const result = await mot.screenshot(path);
      if ("path" in result) {
        expect(result.path).toBe(path);
        expect(result.byteCount).toBeGreaterThan(0);
      } else {
        throw new Error("expected { path, byteCount } result");
      }
      // ファイルの内容を読み戻して PNG signature を確認
      const fileBuffer = await fsp.readFile(path);
      expect(fileBuffer.byteLength).toBe(result.byteCount);
      expect(fileBuffer.subarray(0, 4)).toEqual(PNG_SIGNATURE);
    } finally {
      await fsp.rm(path, { force: true });
      harness.stop();
    }
  });

  test("fullPage: false がリクエストに伝搬される", async () => {
    const harness = await startCapturingBridge(async () => ({
      dataUrl: SAMPLE_DATA_URL,
      byteCount: 70,
    }));
    const mot = new BunMot({ port: harness.port });
    const path = join(tmpdir(), `bun-mot-screenshot-test-fp-${Date.now()}.png`);
    try {
      await mot.screenshot(path, { fullPage: false });
      expect(harness.receivedRequests[0]?.fullPage).toBe(false);
    } finally {
      await fsp.rm(path, { force: true });
      harness.stop();
    }
  });

  test("path 省略 + fullPage 省略でも fullPage: true がリクエストに乗る", async () => {
    const harness = await startCapturingBridge(async () => ({
      dataUrl: SAMPLE_DATA_URL,
      byteCount: 70,
    }));
    const mot = new BunMot({ port: harness.port });
    await mot.screenshot();
    expect(harness.receivedRequests[0]?.fullPage).toBe(true);
    harness.stop();
  });

  test("viewId 配線: リクエスト body に viewId が乗る", async () => {
    const harness = await startCapturingBridge(async () => ({
      dataUrl: SAMPLE_DATA_URL,
      byteCount: 70,
    }));
    const mot = new BunMot({ port: harness.port, viewId: "screenshot-view" });
    await mot.screenshot();
    expect(harness.receivedRequests[0]?.viewId).toBe("screenshot-view");
    harness.stop();
  });

  test("予期せぬ shape (dataUrl 欠落) で BunMotError(internal_error)", async () => {
    const harness = await startCapturingBridge(async () => ({ byteCount: 0 }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.screenshot();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotError);
    if (caught instanceof BunMotError) {
      expect(caught.kind).toBe("internal_error");
      expect(caught.message).toContain("screenshot:");
    }
    harness.stop();
  });

  test("evaluation_error → BunMotError(evaluation_error) が throw", async () => {
    const harness = await startCapturingBridge(async () => null, () => ({
      success: false,
      error: {
        kind: "evaluation_error",
        message: "Tainted canvases may not be exported",
      },
    }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.screenshot();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotError);
    if (caught instanceof BunMotError) {
      expect(caught.kind).toBe("evaluation_error");
      expect(caught.message).toContain("Tainted");
    }
    harness.stop();
  });

  test("driver は常に buffer.byteLength を返す (wire の byteCount が誤っていても)", async () => {
    // wire の byteCount を意図的に間違った値で返しても driver は再計算した正しい値を返す。
    // 大きく異なる場合は warn ログを出す (throw しない)。
    const harness = await startCapturingBridge(async () => ({
      dataUrl: SAMPLE_DATA_URL,
      byteCount: 999999, // 嘘の値
    }));
    const mot = new BunMot({ port: harness.port });
    const result = await mot.screenshot();
    if ("buffer" in result) {
      expect(result.byteCount).toBe(result.buffer.byteLength);
      expect(result.byteCount).not.toBe(999999);
    } else {
      throw new Error("expected buffer result");
    }
    harness.stop();
  });

  // path === "" は driver でガードしない (Playwright と同じく fs.writeFile に任せて raw throw)。
  // ENOENT や類似のエラーになるが、これは意図しない使い方として呼び出し側責務とする。
  test("path に空文字 \"\" を渡すと fs.writeFile の raw error が throw される", async () => {
    const harness = await startCapturingBridge(async () => ({
      dataUrl: SAMPLE_DATA_URL,
      byteCount: 70,
    }));
    const mot = new BunMot({ port: harness.port });
    let caught: unknown;
    try {
      await mot.screenshot("");
    } catch (e) {
      caught = e;
    }
    // BunMotError ではなく fs/Node の raw error
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(BunMotError);
    harness.stop();
  });
});
