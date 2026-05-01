import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { log } from "../src/logger";

describe("logger", () => {
  let originalLog: typeof console.log;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (msg: string): void => {
      captured.push(msg);
    };
  });

  afterEach(() => {
    console.log = originalLog;
    delete process.env["BUN_MOT_LOG"];
  });

  test("ISO 8601 タイムスタンプ + イベント名 + フィールドのフォーマットで出力される", () => {
    log("bridge_started", { port: 3000, hostname: "127.0.0.1" });
    expect(captured).toHaveLength(1);
    const line = captured[0];
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] bridge_started port=3000 hostname=127\.0\.0\.1$/,
    );
  });

  test("フィールドなしの場合はイベント名のみ出力される", () => {
    log("bridge_stopped");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatch(/^\[.+\] bridge_stopped$/);
  });

  test("undefined フィールドは出力されない", () => {
    log("command_received", { type: "evaluate", viewId: undefined });
    expect(captured[0]).toMatch(/type=evaluate/);
    expect(captured[0]).not.toMatch(/viewId/);
  });

  test("BUN_MOT_LOG=silent で no-op になる", () => {
    process.env["BUN_MOT_LOG"] = "silent";
    log("bridge_started", { port: 3000 });
    expect(captured).toHaveLength(0);
  });

  test("空白を含む値は JSON.stringify でクォートされる", () => {
    log("event", { message: "hello world" });
    expect(captured[0]).toMatch(/message="hello world"/);
  });

  test("= を含む値は JSON.stringify でクォートされる", () => {
    log("event", { kv: "a=b" });
    expect(captured[0]).toMatch(/kv="a=b"/);
  });

  test("フィールドキーは camelCase である (snake_case を使わない)", () => {
    // logger 自身が key を変換する責任は負わないが、
    // 呼び出し側が camelCase で渡す前提を回帰防止のため確認
    log("command_completed", { durationMs: 100, viewId: "main" });
    expect(captured[0]).not.toMatch(/duration_ms/);
    expect(captured[0]).not.toMatch(/view_id/);
    expect(captured[0]).toMatch(/durationMs=100/);
    expect(captured[0]).toMatch(/viewId=main/);
  });

  test("boolean / number / null をシリアライズできる", () => {
    log("event", { success: true, count: 42, value: null });
    expect(captured[0]).toMatch(/success=true/);
    expect(captured[0]).toMatch(/count=42/);
    expect(captured[0]).toMatch(/value=null/);
  });
});
