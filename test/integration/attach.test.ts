import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { BunMot } from "../../src";

beforeAll(() => {
  process.env["BUN_MOT_LOG"] = "silent";
});
afterAll(() => {
  delete process.env["BUN_MOT_LOG"];
});

const FIXTURE_PATH = resolve(import.meta.dir, "../fixtures/sample-app/main.ts");

test(
  "attach() で別 spawn の sample-app に接続 → evaluate → dispose してもプロセスは生きている",
  async () => {
    // Arrange: launch() を経由せず Bun.spawn で直接 spawn する。
    // attach() の独立性 (launch なしで動く) を test 表現としても担保する。
    const child = Bun.spawn(
      ["bun", FIXTURE_PATH],
      {
        env: { ...process.env, BUN_MOT_PORT: "0", BUN_MOT_LOG: "silent" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    // stdout から `fixture-bridge-ready port=NNNN` を読み取って実 port を抽出。
    // launch.ts の `pumpStream` は export しない方針 (internal helper のままにする) なので
    // ここで test 用の最小 reader を手書きする。
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let port: number | null = null;
    while (port === null) {
      const { value, done } = await reader.read();
      if (done) throw new Error("sample-app exited before bridge-ready");
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/fixture-bridge-ready port=(\d+)/);
      if (m && m[1] !== undefined) port = Number(m[1]);
    }
    reader.releaseLock();

    try {
      // Act
      const mot = await BunMot.attach({ port });
      const result = await mot.evaluate("1");
      expect(result).toBe(1);

      const result2 = await mot.evaluate("'attach'.length");
      expect(result2).toBe(6);

      await mot.dispose();

      // Assert: dispose 後もプロセスは生存している (attach は所有権を持たない)。
      // POSIX 依存の `process.kill(child.pid, 0)` ではなく Bun.spawn の child.exitCode を使う。
      expect(child.exitCode).toBeNull();
    } finally {
      // cleanup: テストオーナーがプロセスを kill する責任を負う。
      child.kill("SIGTERM");
      await child.exited;
    }
  },
  30_000,
);
