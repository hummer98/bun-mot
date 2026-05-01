import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { setupBunMot } from "../src/bridge";
import { BunMot } from "../src/driver";
import type { BunMotView } from "../src/types";
import { BunMotError } from "../src/errors";

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
};

interface BridgeHarness {
  port: number;
  evalMock: ReturnType<typeof mock<EvalImpl>>;
  receivedRequests: CapturedRequest[];
  stop: () => void;
}

// driver から bridge に届いた request body を捕捉するため、
// HTTP は実際に setupBunMot で起動し、別途リクエスト捕捉用のサーバーをラップする。
async function startCapturingBridge(evalImpl: EvalImpl): Promise<BridgeHarness> {
  const evalMock = mock(evalImpl);
  const view: BunMotView = {
    rpc: { request: { evaluateJavascriptWithResponse: evalMock } },
  };
  // setupBunMot は body をそのまま使うため、driver の組み立てが正しいかの検証は
  // 「mockEvalImpl が呼ばれた script」よりも「driver → bridge 直接 fetch」を見るのが分かりやすい。
  // ここでは simple wrapper: setupBunMot に渡す view の middleware で body を覗くことができないので、
  // 代替として driver が使う BunMotClient.send をスパイするのではなく、bridge に届いた request を
  // 専用の interceptor 経由で取得する。
  // 実装簡単化のため: setupBunMot ではなく独立した capturing server を立てて driver の HTTP を受ける。
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
      try {
        // 受け取った body の type に応じて mock を呼ぶ (script は不問)
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
