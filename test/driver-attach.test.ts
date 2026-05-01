import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { BunMot, BunMotScopedView } from "../src/driver";
import { BunMotError } from "../src/errors";
import type { ConnectAdapter } from "../src/launch";

beforeAll(() => {
  process.env["BUN_MOT_LOG"] = "silent";
});
afterAll(() => {
  delete process.env["BUN_MOT_LOG"];
});

// ===== Mock ConnectAdapter =====

interface MockConnectHandle extends ConnectAdapter {
  attempts: Array<{ host: string; port: number }>;
}

/**
 * acceptingPorts に含まれる port のみ tryConnect が true を返す mock。
 * 全 attempt を attempts に蓄積するので test 側で件数や引数を assert できる。
 */
function makeMockConnect(opts: {
  acceptingPorts?: Set<number>;
  onAttempt?: (host: string, port: number) => void;
}): MockConnectHandle {
  const attempts: Array<{ host: string; port: number }> = [];
  return {
    attempts,
    tryConnect: async (host, port): Promise<boolean> => {
      attempts.push({ host, port });
      opts.onAttempt?.(host, port);
      return opts.acceptingPorts?.has(port) ?? false;
    },
  };
}

/**
 * sequence に従って true/false を 1 回ずつ返す mock。リトライ動作の確認用。
 */
function makeSequencedConnect(sequence: boolean[]): MockConnectHandle {
  const attempts: Array<{ host: string; port: number }> = [];
  let i = 0;
  return {
    attempts,
    tryConnect: async (host, port): Promise<boolean> => {
      attempts.push({ host, port });
      const v = sequence[i] ?? false;
      i += 1;
      return v;
    },
  };
}

// ===== Capturing bridge (実 Bun.serve) =====
// scopedView の動作確認 (#13) で実 fetch が必要なため。

interface CapturingHarness {
  port: number;
  receivedRequests: Array<{ type: string; viewId?: string }>;
  stop: () => void;
}

async function startCapturingBridge(): Promise<CapturingHarness> {
  const requests: Array<{ type: string; viewId?: string }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname !== "/command" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as { type: string; viewId?: string };
      requests.push(body);
      return new Response(JSON.stringify({ success: true, result: 1 }), {
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

// ===========================================================
// A. attach の正常系 / リトライ
// ===========================================================

describe("BunMot.attach() — 正常系 / リトライ", () => {
  test("ケース 1: attach({ port }) → tryConnect 成功で BunMot インスタンスを返す", async () => {
    const PORT = 51111;
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set([PORT]) });
    const mot = await BunMot.attach({ port: PORT, connectAdapter });
    expect(mot).toBeInstanceOf(BunMot);
    expect(connectAdapter.attempts.length).toBeGreaterThanOrEqual(1);
    expect(connectAdapter.attempts[0]?.port).toBe(PORT);
  });

  test("ケース 3: 1 回失敗 → 1 回成功 のシーケンスでリトライ成功", async () => {
    const PORT = 51112;
    const connectAdapter = makeSequencedConnect([false, true]);
    const mot = await BunMot.attach({ port: PORT, connectAdapter, timeout: 2000 });
    expect(mot).toBeInstanceOf(BunMot);
    expect(connectAdapter.attempts.length).toBe(2);
    expect(connectAdapter.attempts[0]?.port).toBe(PORT);
    expect(connectAdapter.attempts[1]?.port).toBe(PORT);
  });

  test("ケース 4: hostname=0.0.0.0 → connectAdapter に host として渡される", async () => {
    const PORT = 51113;
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set([PORT]) });
    await BunMot.attach({ port: PORT, hostname: "0.0.0.0", connectAdapter });
    expect(connectAdapter.attempts[0]?.host).toBe("0.0.0.0");
  });

  test("hostname 未指定 → デフォルト 127.0.0.1 が使われる", async () => {
    const PORT = 51114;
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set([PORT]) });
    await BunMot.attach({ port: PORT, connectAdapter });
    expect(connectAdapter.attempts[0]?.host).toBe("127.0.0.1");
  });
});

// ===========================================================
// A. attach のタイムアウト
// ===========================================================

describe("BunMot.attach() — timeout", () => {
  test("ケース 2: 全 probe 失敗 → timeout ms 経過で BunMotError(internal_error) reject", async () => {
    const PORT = 52000;
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set() });
    let caught: unknown;
    try {
      await BunMot.attach({ port: PORT, timeout: 100, connectAdapter });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotError);
    if (caught instanceof BunMotError) {
      expect(caught.kind).toBe("internal_error");
      expect(caught.message).toMatch(/bun-mot attach timeout after \d+ms/);
      expect(caught.message).toContain(`127.0.0.1:${PORT}`);
    }
    // 少なくとも 1 回は probe が走っている
    expect(connectAdapter.attempts.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================
// B. attach の port バリデーション
// ===========================================================

describe("BunMot.attach() — port バリデーション", () => {
  test.each([
    ["ケース 5: port=0", 0],
    ["ケース 6: port=70000", 70000],
    ["ケース 7: port=-1", -1],
    ["ケース 8: port=3.14 (非整数)", 3.14],
  ])("%s → BunMotError(validation_error) を即時 throw、probe は走らない", async (_label, port) => {
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set() });
    let caught: unknown;
    try {
      await BunMot.attach({ port: port as number, connectAdapter });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BunMotError);
    if (caught instanceof BunMotError) {
      expect(caught.kind).toBe("validation_error");
      expect(caught.message).toMatch(/attach: invalid port: /);
      expect(caught.message).toContain(String(port));
    }
    // probe が 1 回も走らないことを確認
    expect(connectAdapter.attempts.length).toBe(0);
  });
});

// ===========================================================
// C. dispose / throwIfDisposed
// ===========================================================

describe("BunMot.dispose() — 冪等性 / 副作用なし", () => {
  test("ケース 9: dispose() を 2 回呼んでも throw しない (冪等)", async () => {
    const mot = new BunMot({ port: 50001 });
    await mot.dispose();
    await mot.dispose();
    expect(true).toBe(true);
  });

  test("ケース 10: dispose() は ConnectAdapter に副作用 (追加 tryConnect 等) を起こさない", async () => {
    const PORT = 50002;
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set([PORT]) });
    const mot = await BunMot.attach({ port: PORT, connectAdapter });
    const attemptsBeforeDispose = connectAdapter.attempts.length;
    await mot.dispose();
    expect(connectAdapter.attempts.length).toBe(attemptsBeforeDispose);
  });
});

// ===========================================================
// C. dispose 後の各 command が throw する (test.each で 11 method 全網羅)
// ===========================================================

describe("BunMot — dispose() 後の各 command は BunMotError(internal_error) を throw する (ケース 11)", () => {
  // 各 method を呼び出して throw を捕捉する関数を定義。
  // 引数シグネチャに合わせた最小引数を渡す。
  type MethodCall = (mot: BunMot) => Promise<unknown>;
  const methodCalls: Array<[string, MethodCall]> = [
    ["evaluate", (m) => m.evaluate("1")],
    ["waitForSelector", (m) => m.waitForSelector(".x")],
    ["getText", (m) => m.getText(".x")],
    ["click", (m) => m.click(".x")],
    ["fill", (m) => m.fill(".x", "v")],
    ["waitForHidden", (m) => m.waitForHidden(".x")],
    ["waitForText", (m) => m.waitForText(".x", "y")],
    ["isVisible", (m) => m.isVisible(".x")],
    ["getAttribute", (m) => m.getAttribute(".x", "id")],
    ["getLogs", (m) => m.getLogs()],
    ["screenshot", (m) => m.screenshot()],
  ];

  test.each(methodCalls)(
    "dispose() 後の %s() は BunMotError('BunMot has been disposed', 'internal_error') を throw する",
    async (_name, call) => {
      // listen していない port を指定しても throwIfDisposed が先に走るので fetch は発生しない。
      const mot = new BunMot({ port: 1 });
      await mot.dispose();
      let caught: unknown;
      try {
        await call(mot);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BunMotError);
      if (caught instanceof BunMotError) {
        expect(caught.kind).toBe("internal_error");
        expect(caught.message).toBe("BunMot has been disposed");
      }
    },
  );
});

// ===========================================================
// C. dispose 後の view() / scopedView の挙動
// ===========================================================

describe("BunMot — dispose() 後の view() / scopedView", () => {
  test("ケース 12: dispose() 後の view() 呼び出しは BunMotError(internal_error) を throw する", async () => {
    const mot = new BunMot({ port: 1 });
    await mot.dispose();
    expect(() => mot.view("label")).toThrow(BunMotError);
    try {
      mot.view("label");
    } catch (e) {
      expect(e).toBeInstanceOf(BunMotError);
      if (e instanceof BunMotError) {
        expect(e.kind).toBe("internal_error");
        expect(e.message).toBe("BunMot has been disposed");
      }
    }
  });

  test("ケース 13 (v1 の制限): dispose() 前に取得した scopedView は、親が dispose 後でも bridge が生きていれば evaluate できる", async () => {
    const harness = await startCapturingBridge();
    try {
      const mot = new BunMot({ port: harness.port });
      // 親 dispose 前に scopedView を取得しておく
      const scoped = mot.view("main");
      expect(scoped).toBeInstanceOf(BunMotScopedView);
      await mot.dispose();
      // 親が dispose されても scopedView は disposed flag を見ない (v1 仕様)
      const result = await scoped.evaluate("1");
      expect(result).toBe(1);
      expect(harness.receivedRequests[0]?.viewId).toBe("main");
    } finally {
      harness.stop();
    }
  });
});

// ===========================================================
// D. dispose 後でも throw しない method
// ===========================================================

describe("BunMot — dispose() 後でも throw しない method", () => {
  test("ケース 14: dispose() 後の pass() は throw しない (console.log のみ、bridge 通信なし)", async () => {
    const mot = new BunMot({ port: 1 });
    await mot.dispose();
    // pass() は dispose 後でも throw せず resolve する
    const origLog = console.log;
    console.log = (): void => {};
    try {
      await mot.pass();
      await mot.pass("with-message");
    } finally {
      console.log = origLog;
    }
    expect(true).toBe(true);
  });
});
