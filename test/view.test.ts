import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { BunMot, BunMotScopedView } from "../src/driver";

beforeAll(() => {
  process.env["BUN_MOT_LOG"] = "silent";
});
afterAll(() => {
  delete process.env["BUN_MOT_LOG"];
});

type CapturedRequest = {
  type: string;
  expression?: string;
  selector?: string;
  timeout?: number;
  viewId?: string;
};

interface CapturingHarness {
  port: number;
  receivedRequests: CapturedRequest[];
  stop: () => void;
}

// driver からの request を捕捉して固定 result を返す簡易ブリッジ。
async function startCapturingBridge(): Promise<CapturingHarness> {
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
      // request type に応じて適切な shape の result を返す
      let result: unknown;
      switch (body.type) {
        case "waitForSelector":
          result = { found: true };
          break;
        case "getText":
          result = { text: "ok" };
          break;
        default:
          result = 1;
      }
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("Bun.serve did not return a port");
  }
  return {
    port,
    receivedRequests: requests,
    stop: (): void => {
      server.stop(true);
    },
  };
}

describe("BunMot.view() — scoped view", () => {
  test("view() は BunMotScopedView を返す", async () => {
    const harness = await startCapturingBridge();
    const mot = new BunMot({ port: harness.port });
    const scoped = mot.view("main");
    expect(scoped).toBeInstanceOf(BunMotScopedView);
    harness.stop();
  });

  test("scoped.evaluate() の request body に viewId が乗る", async () => {
    const harness = await startCapturingBridge();
    const mot = new BunMot({ port: harness.port });
    await mot.view("main").evaluate("1+1");
    expect(harness.receivedRequests[0]?.viewId).toBe("main");
    expect(harness.receivedRequests[0]?.type).toBe("evaluate");
    harness.stop();
  });

  test("scoped.waitForSelector() の request body に viewId が乗る", async () => {
    const harness = await startCapturingBridge();
    const mot = new BunMot({ port: harness.port });
    await mot.view("side").waitForSelector(".x");
    expect(harness.receivedRequests[0]?.viewId).toBe("side");
    expect(harness.receivedRequests[0]?.type).toBe("waitForSelector");
    harness.stop();
  });

  test("scoped.getText() の request body に viewId が乗る", async () => {
    const harness = await startCapturingBridge();
    const mot = new BunMot({ port: harness.port });
    await mot.view("panel").getText("h1");
    expect(harness.receivedRequests[0]?.viewId).toBe("panel");
    expect(harness.receivedRequests[0]?.type).toBe("getText");
    harness.stop();
  });

  test("親 mot の viewId は scoped 後も不変 (immutable scope)", async () => {
    const harness = await startCapturingBridge();
    const mot = new BunMot({ port: harness.port });
    // scoped view を作るだけでは親の挙動は変わらない
    mot.view("main");
    await mot.evaluate("1");
    // 親の request には viewId が乗らない
    expect(harness.receivedRequests[0]?.viewId).toBeUndefined();
    harness.stop();
  });

  test("親 mot の viewId 指定がある場合でも scoped は scoped の name で上書きする", async () => {
    const harness = await startCapturingBridge();
    const mot = new BunMot({ port: harness.port, viewId: "primary" });
    // 親は primary、scoped は secondary
    await mot.view("secondary").evaluate("1");
    expect(harness.receivedRequests[0]?.viewId).toBe("secondary");
    // 親自身を呼ぶと primary
    await mot.evaluate("1");
    expect(harness.receivedRequests[1]?.viewId).toBe("primary");
    harness.stop();
  });

  test("view().view() は最後の name が勝つ (replace 方式)", async () => {
    const harness = await startCapturingBridge();
    const mot = new BunMot({ port: harness.port });
    await mot.view("a").view("b").evaluate("1");
    expect(harness.receivedRequests[0]?.viewId).toBe("b");
    harness.stop();
  });

  test("BunMotScopedView は親 BunMot への back-reference を expose しない", async () => {
    const harness = await startCapturingBridge();
    const mot = new BunMot({ port: harness.port });
    const scoped = mot.view("main");
    // public プロパティに parent / mot 等を生やしていないことを確認
    const publicKeys = Object.keys(scoped);
    expect(publicKeys).not.toContain("parent");
    expect(publicKeys).not.toContain("mot");
    // BunMot インスタンスを保持していないことの追加チェック
    for (const key of publicKeys) {
      const value = (scoped as unknown as Record<string, unknown>)[key];
      expect(value).not.toBeInstanceOf(BunMot);
    }
    harness.stop();
  });
});
