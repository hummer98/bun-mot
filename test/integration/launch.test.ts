import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { launch } from "../../src/launch";

beforeAll(() => {
  process.env["BUN_MOT_LOG"] = "silent";
});
afterAll(() => {
  delete process.env["BUN_MOT_LOG"];
});

const FIXTURE_PATH = resolve(import.meta.dir, "../fixtures/sample-app/main.ts");

describe("launch() — sample-app fixture を実 spawn する", () => {
  test(
    "port=0 で起動 → stdout から port 抽出 → bridge 接続成立 → mot.evaluate('1') で 1 が返る → close 後はプロセスが死んでいる",
    async () => {
      const { app, mot } = await launch({
        appPath: FIXTURE_PATH,
        readyTimeout: 8000,
        env: { BUN_MOT_LOG: "silent" },
      });

      try {
        // 抽出した port が 0 ではない (実 port が割り当てられた)
        expect(app.port).toBeGreaterThan(0);
        expect(app.pid).toBeGreaterThan(0);

        // bridge 経由でコマンドが通る
        const result = await mot.evaluate("1");
        expect(result).toBe(1);

        // もう一回呼んでも通る
        const result2 = await mot.evaluate("'hello'.length");
        expect(result2).toBe(5);
      } finally {
        await app.close();
      }

      // close 後はプロセスが死んでいる (kill -0 で確認)
      // SIGTERM 送信後に process.exit(0) が走るため、シグナル送信〜実 exit までに少し時間がかかる。
      // launch.ts の kill() は SIGTERM → 1.5s で SIGKILL するので、close() 戻り時点で既に死んでいるはず。
      let aliveAfterClose = false;
      try {
        process.kill(app.pid, 0);
        aliveAfterClose = true;
      } catch {
        aliveAfterClose = false;
      }
      expect(aliveAfterClose).toBe(false);
    },
    15000,
  );

  test("close() は冪等 (二度呼んでも throw しない)", async () => {
    const { app } = await launch({
      appPath: FIXTURE_PATH,
      readyTimeout: 8000,
      env: { BUN_MOT_LOG: "silent" },
    });
    await app.close();
    await app.close(); // 2 回目でも throw しない
    expect(true).toBe(true);
  }, 15000);
});
