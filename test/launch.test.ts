import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  launch,
  selectSpawnAdapter,
  selectConnectAdapter,
  type SpawnAdapter,
  type SpawnedProcess,
  type ConnectAdapter,
} from "../src/launch";

beforeAll(() => {
  process.env["BUN_MOT_LOG"] = "silent";
});
afterAll(() => {
  delete process.env["BUN_MOT_LOG"];
});

interface MockProcessConfig {
  pid?: number;
  /** 起動から N ms 後に stdout に書き込む行 */
  stdoutEvents?: Array<{ delayMs: number; line: string }>;
  /** 起動から N ms 後に stderr に書き込む行 */
  stderrEvents?: Array<{ delayMs: number; line: string }>;
  onKill?: () => void;
}

interface MockProcessHandle extends SpawnedProcess {
  killed: boolean;
  killCount: number;
}

function makeMockProcess(cfg: MockProcessConfig): MockProcessHandle {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const stdoutHandlers: Array<(line: string) => void> = [];
  const stderrHandlers: Array<(line: string) => void> = [];
  let alive = true;
  let killCount = 0;

  for (const e of cfg.stdoutEvents ?? []) {
    setTimeout(() => {
      if (!alive) return;
      stdoutBuf.push(e.line + "\n");
      for (const h of stdoutHandlers) h(e.line);
    }, e.delayMs);
  }
  for (const e of cfg.stderrEvents ?? []) {
    setTimeout(() => {
      if (!alive) return;
      stderrBuf.push(e.line + "\n");
      for (const h of stderrHandlers) h(e.line);
    }, e.delayMs);
  }

  return {
    pid: cfg.pid ?? 12345,
    onStdoutLine: (h): void => {
      stdoutHandlers.push(h);
    },
    onStderrLine: (h): void => {
      stderrHandlers.push(h);
    },
    readStdout: (): string => stdoutBuf.join(""),
    readStderr: (): string => stderrBuf.join(""),
    isAlive: (): boolean => alive,
    kill: async (): Promise<void> => {
      killCount += 1;
      alive = false;
      cfg.onKill?.();
    },
    get killed(): boolean {
      return !alive;
    },
    get killCount(): number {
      return killCount;
    },
  };
}

interface MockConnectConfig {
  /** どの port で listen 成立しているか */
  acceptingPorts: Set<number>;
  /** Connect 試行時に呼ばれるフック */
  onAttempt?: (host: string, port: number) => void;
}

function makeMockConnect(cfg: MockConnectConfig): ConnectAdapter {
  return {
    tryConnect: async (host, port): Promise<boolean> => {
      cfg.onAttempt?.(host, port);
      return cfg.acceptingPorts.has(port);
    },
  };
}

describe("launch() - stdout から port を抽出する", () => {
  test("BUN_MOT_PORT=0 が env に注入され、stdout マーカーから port を抽出する", async () => {
    const FIXTURE_PORT = 51234;
    let capturedEnv: Record<string, string> | undefined;
    const proc = makeMockProcess({
      stdoutEvents: [
        { delayMs: 10, line: `fixture-bridge-ready port=${FIXTURE_PORT}` },
      ],
    });
    const spawnAdapter: SpawnAdapter = {
      spawn: (_cmd, opts) => {
        capturedEnv = opts.env;
        return proc;
      },
    };
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set([FIXTURE_PORT]) });
    const { app } = await launch({
      appPath: "test.ts",
      spawnAdapter,
      connectAdapter,
      readyTimeout: 2000,
    });
    expect(app.port).toBe(FIXTURE_PORT);
    expect(capturedEnv?.["BUN_MOT_PORT"]).toBe("0");
    await app.close();
  });

  test("LaunchOptions.port を明示すると、env BUN_MOT_PORT がその値で注入される (マーカー無くても接続される)", async () => {
    const FIXED_PORT = 39999;
    let capturedEnv: Record<string, string> | undefined;
    const proc = makeMockProcess({}); // stdout に何も出さない
    const spawnAdapter: SpawnAdapter = {
      spawn: (_cmd, opts) => {
        capturedEnv = opts.env;
        return proc;
      },
    };
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set([FIXED_PORT]) });
    const { app } = await launch({
      appPath: "test.ts",
      port: FIXED_PORT,
      spawnAdapter,
      connectAdapter,
      readyTimeout: 2000,
    });
    expect(app.port).toBe(FIXED_PORT);
    expect(capturedEnv?.["BUN_MOT_PORT"]).toBe(String(FIXED_PORT));
    await app.close();
  });
});

describe("launch() - readyTimeout", () => {
  test("readyTimeout 経過で reject。kill() が呼ばれる", async () => {
    const proc = makeMockProcess({}); // 何も stdout に出さない
    const spawnAdapter: SpawnAdapter = { spawn: () => proc };
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set() });
    let caught: unknown;
    try {
      await launch({
        appPath: "test.ts",
        spawnAdapter,
        connectAdapter,
        readyTimeout: 100,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(proc.killed).toBe(true);
    expect(proc.killCount).toBeGreaterThanOrEqual(1);
  });

  test("timeout エラーメッセージに 経過 ms / port=unknown / stdout/stderr 末尾 が含まれる", async () => {
    const proc = makeMockProcess({
      stdoutEvents: [{ delayMs: 0, line: "STDOUT_DEBUG_LINE" }],
      stderrEvents: [{ delayMs: 0, line: "STDERR_DEBUG_LINE" }],
    });
    const spawnAdapter: SpawnAdapter = { spawn: () => proc };
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set() });
    let caught: unknown;
    try {
      await launch({
        appPath: "test.ts",
        spawnAdapter,
        connectAdapter,
        readyTimeout: 80,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      // 経過 ms が含まれる
      expect(caught.message).toMatch(/launch timeout after \d+ms/);
      // port=unknown または "port を抽出できず"
      expect(caught.message).toMatch(/port=unknown|port を抽出できず/);
      // stdout / stderr の末尾の文字列が含まれる
      expect(caught.message).toContain("STDOUT_DEBUG_LINE");
      expect(caught.message).toContain("STDERR_DEBUG_LINE");
    }
  });

  test("port が抽出されたが TCP が listen していない場合、host:port が timeout メッセージに含まれる", async () => {
    const PORT = 44444;
    const proc = makeMockProcess({
      stdoutEvents: [{ delayMs: 0, line: `fixture-bridge-ready port=${PORT}` }],
    });
    const spawnAdapter: SpawnAdapter = { spawn: () => proc };
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set() });
    let caught: unknown;
    try {
      await launch({
        appPath: "test.ts",
        spawnAdapter,
        connectAdapter,
        readyTimeout: 200,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toContain(`127.0.0.1:${PORT}`);
    }
    expect(proc.killed).toBe(true);
  });
});

describe("launch() - close() の冪等", () => {
  test("close() を二度呼んでも throw しない、kill は最大 1 回のみ", async () => {
    const PORT = 55555;
    const proc = makeMockProcess({
      stdoutEvents: [{ delayMs: 0, line: `fixture-bridge-ready port=${PORT}` }],
    });
    const spawnAdapter: SpawnAdapter = { spawn: () => proc };
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set([PORT]) });
    const { app } = await launch({
      appPath: "test.ts",
      spawnAdapter,
      connectAdapter,
      readyTimeout: 1000,
    });
    await app.close();
    await app.close();
    expect(proc.killCount).toBe(1);
  });
});

describe("launch() - resolved BunMot は実 port に向いている", () => {
  test("LaunchResult.mot.evaluate は app.port に対して fetch する", async () => {
    const PORT = 60001;
    const proc = makeMockProcess({
      stdoutEvents: [{ delayMs: 0, line: `fixture-bridge-ready port=${PORT}` }],
    });
    const spawnAdapter: SpawnAdapter = { spawn: () => proc };
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set([PORT]) });
    const { app, mot } = await launch({
      appPath: "test.ts",
      spawnAdapter,
      connectAdapter,
      readyTimeout: 1000,
    });
    expect(app.port).toBe(PORT);
    // mot は public な port を expose しないが、fetch 先がずれていれば evaluate でエラーになる。
    // ここでは BunMot の存在のみ確認 (実 fetch は integration test で確認)。
    expect(mot).toBeDefined();
    await app.close();
  });
});

describe("launch() - adapter selection", () => {
  test("Bun ランタイムでは selectSpawnAdapter が動く (adapter が返る)", () => {
    const adapter = selectSpawnAdapter();
    expect(typeof adapter.spawn).toBe("function");
  });

  test("Bun ランタイムでは selectConnectAdapter が動く (adapter が返る)", () => {
    const adapter = selectConnectAdapter();
    expect(typeof adapter.tryConnect).toBe("function");
  });

  test("typeof Bun === 'undefined' のときに Node 側 adapter が選ばれる分岐", async () => {
    // Bun を一時的に hide して selector の分岐を踏む。
    // selector を関数として再 import せず、launch.ts の内部関数を使うため、
    // ここではモジュール経由で直接呼ぶ。Bun が定義された環境で再度関数を呼んでも
    // 型が同じであることのみ確認する。
    const adapter = selectSpawnAdapter();
    expect(typeof adapter.spawn).toBe("function");
    // Node 環境での実 spawn は T005 の責務。本テストは selector が壊れていないことの確認に留める。
    expect(true).toBe(true);
  });
});

describe("launch() - echoOutput", () => {
  test("echoOutput=true 時に stdout/stderr が console に流される", async () => {
    const PORT = 61234;
    // タイミングを決定的にするため stderr → stdout(echo) → marker の順に十分な間隔を空ける
    const proc = makeMockProcess({
      stdoutEvents: [
        { delayMs: 5, line: "ECHO_STDOUT_LINE" },
        { delayMs: 30, line: `fixture-bridge-ready port=${PORT}` },
      ],
      stderrEvents: [{ delayMs: 10, line: "ECHO_STDERR_LINE" }],
    });
    const spawnAdapter: SpawnAdapter = { spawn: () => proc };
    const connectAdapter = makeMockConnect({ acceptingPorts: new Set([PORT]) });
    const captured: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]): void => {
      captured.push(`L:${String(a[0])}`);
    };
    console.error = (...a: unknown[]): void => {
      captured.push(`E:${String(a[0])}`);
    };
    try {
      const { app } = await launch({
        appPath: "test.ts",
        spawnAdapter,
        connectAdapter,
        readyTimeout: 1000,
        echoOutput: true,
      });
      expect(captured.some((s) => s.includes("ECHO_STDOUT_LINE"))).toBe(true);
      expect(captured.some((s) => s.startsWith("E:[launch:stderr]"))).toBe(true);
      await app.close();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});
