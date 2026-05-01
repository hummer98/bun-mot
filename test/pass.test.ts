import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { BunMot } from "../src/driver";

beforeAll(() => {
  process.env["BUN_MOT_LOG"] = "silent";
});
afterAll(() => {
  delete process.env["BUN_MOT_LOG"];
});

describe("BunMot.pass()", () => {
  test("console.log を 1 回呼び、🚐✅ を含むメッセージを出す", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const mot = new BunMot({ port: 0 });
      await mot.pass();
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0];
      expect(call).toBeDefined();
      const arg = call?.[0];
      expect(typeof arg).toBe("string");
      expect(arg).toContain("🚐✅");
      expect(arg).toContain("bun-mot");
      expect(arg).toContain("all assertions passed");
    } finally {
      spy.mockRestore();
    }
  });

  test("message 引数が出力に含まれる", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const mot = new BunMot({ port: 0 });
      await mot.pass("Mermaid renders");
      const call = spy.mock.calls[0];
      const arg = call?.[0];
      expect(typeof arg).toBe("string");
      expect(arg).toContain("Mermaid renders");
    } finally {
      spy.mockRestore();
    }
  });

  test("戻り値は Promise<void>", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const mot = new BunMot({ port: 0 });
      const ret = mot.pass();
      expect(ret).toBeInstanceOf(Promise);
    } finally {
      spy.mockRestore();
    }
  });

  test("BUN_MOT_LOG=silent でも console.log は呼ばれる (user-facing 表示)", async () => {
    // beforeAll で既に silent に設定されているため、本テスト内で改めて確認する
    expect(process.env["BUN_MOT_LOG"]).toBe("silent");
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const mot = new BunMot({ port: 0 });
      await mot.pass();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
