import { BunMot } from "./driver";
import { log } from "./logger";

// tsconfig.build.json の `types: []` で @types/bun の global を読み込まない方針のため、
// 公開 .d.ts への型漏出を防ぎつつ runtime に必要な最小限の global を inline 宣言する。
// runtime では Bun が `process` / `Buffer` を Node 互換で提供する (engines.bun >=1.0.0)。
declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

// Buffer を toString が呼べる程度の最小型として宣言 (Node fallback の dead code 用)。
type LocalBuffer = { toString(encoding: string): string };

// Node fallback (eval require) で使う最小限の Node ストリーム型。
// Bun ランタイムでは bun*Adapter のみ実行されるため、これらは dead code 上の型宣言。
interface LocalNodeReadableStream {
  setEncoding?(encoding: string): void;
  on(event: "data", listener: (chunk: string | LocalBuffer) => void): void;
  on(event: "end", listener: () => void): void;
}

interface LocalProcessEnv {
  [key: string]: string | undefined;
}

/** 起動オプション。spawn・bridge 接続・BunMot 構築を一括で行う。 */
export interface LaunchOptions {
  /** 起動するアプリの実行ファイルパス (必須)。例: "./test/fixtures/sample-app/main.ts" */
  appPath: string;
  /** appPath に渡す追加 argv */
  args?: string[];
  /** spawn の cwd (デフォルト: process.cwd()) */
  cwd?: string;
  /** spawn 時に上書きする env (process.env にマージされる)。BUN_MOT_PORT は launch() が自動付与 */
  env?: Record<string, string>;
  /** bridge port。未指定なら 0 が子に渡され、子の stdout から実 port を読み取る (TOCTOU 回避) */
  port?: number;
  /** bridge hostname (デフォルト: 127.0.0.1)。BunMot に反映 */
  hostname?: string;
  /** bridge 接続待ちのタイムアウト ms (デフォルト: 10000) */
  readyTimeout?: number;
  /** BunMot constructor に渡す defaultTimeout */
  defaultTimeout?: number;
  /** spawn したアプリの stdout/stderr を test runner にエコーするか (デフォルト: false。失敗時のみダンプ) */
  echoOutput?: boolean;
  /** アプリ起動コマンド (デフォルト: "bun")。Node や他のランタイムを使う場合に上書き */
  runtime?: string;
  /** テスト用: spawn を差し替える DI ハンドル。プロダクションでは未指定 */
  spawnAdapter?: SpawnAdapter;
  /** テスト用: TCP 接続確認を差し替える DI ハンドル。プロダクションでは未指定 */
  connectAdapter?: ConnectAdapter;
}

export interface LaunchedApp {
  /** プロセスを優雅に停止する。冪等。 */
  close(): Promise<void>;
  /** spawn された子プロセスの PID */
  readonly pid: number;
  /** 子プロセスが実際に listen している port (stdout から抽出した値) */
  readonly port: number;
  /** stdout を string で取得 (デバッグ用) */
  readStdout(): string;
  /** stderr を string で取得 (デバッグ用) */
  readStderr(): string;
}

export interface LaunchResult {
  app: LaunchedApp;
  mot: BunMot;
}

/** spawn 抽象化 (Bun.spawn / child_process.spawn を吸収)。 */
export interface SpawnedProcess {
  pid: number;
  /** stdout/stderr を行単位で読みつつ string buffer にも蓄積する。 */
  onStdoutLine(handler: (line: string) => void): void;
  onStderrLine(handler: (line: string) => void): void;
  /** 蓄積された stdout/stderr を返す (debug 用)。 */
  readStdout(): string;
  readStderr(): string;
  /** SIGTERM → 1.5s 経過しても生きていれば SIGKILL。 */
  kill(): Promise<void>;
  /** 既に終了しているか。 */
  isAlive(): boolean;
}

export interface SpawnAdapter {
  spawn(cmd: string[], opts: { cwd: string; env: Record<string, string> }): SpawnedProcess;
}

export interface ConnectAdapter {
  /** 指定 host:port に短時間 TCP 接続を試行。成功なら true、失敗なら false を返す (throw しない)。 */
  tryConnect(hostname: string, port: number): Promise<boolean>;
}

const DEFAULT_READY_TIMEOUT_MS = 10000;
const READY_RETRY_INTERVAL_MS = 50;
const STDIO_TAIL_BYTES = 1024;
const FIXTURE_READY_PATTERN = /fixture-bridge-ready port=(\d+)/;

export async function launch(options: LaunchOptions): Promise<LaunchResult> {
  const hostname = options.hostname ?? "127.0.0.1";
  const readyTimeout = options.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();
  const runtime = options.runtime ?? "bun";
  const echoOutput = options.echoOutput ?? false;

  const spawnAdapter = options.spawnAdapter ?? selectSpawnAdapter();
  const connectAdapter = options.connectAdapter ?? selectConnectAdapter();

  const portToPass = options.port ?? 0;
  const env: Record<string, string> = {
    ...filterEnv(process.env),
    ...(options.env ?? {}),
    BUN_MOT_PORT: String(portToPass),
  };

  const cmd = [runtime, options.appPath, ...(options.args ?? [])];

  log("launch_spawning", { appPath: options.appPath, port: portToPass, runtime });

  const child = spawnAdapter.spawn(cmd, { cwd, env });

  // stdout/stderr エコー (任意)
  if (echoOutput) {
    child.onStdoutLine((line) => {
      console.log(`[launch:stdout] ${line}`);
    });
    child.onStderrLine((line) => {
      console.error(`[launch:stderr] ${line}`);
    });
  }

  // port 抽出: 子の stdout から `fixture-bridge-ready port=NNNN` を読み取る。
  // options.port が指定されている場合は、その値を初期値として使い、stdout マーカーが
  // 来たら上書きする (現実的には一致するはず)。
  let resolvedPort: number | undefined = options.port;
  const portWaiters: Array<(p: number) => void> = [];

  child.onStdoutLine((line) => {
    const m = FIXTURE_READY_PATTERN.exec(line);
    if (m && m[1] !== undefined) {
      const p = Number(m[1]);
      if (Number.isFinite(p) && p > 0) {
        resolvedPort = p;
        for (const w of portWaiters) w(p);
        portWaiters.length = 0;
      }
    }
  });

  const start = Date.now();

  const waitForPort = async (): Promise<number> => {
    if (resolvedPort !== undefined && resolvedPort > 0) {
      return resolvedPort;
    }
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("port_unresolved"));
      }, readyTimeout);
      portWaiters.push((p) => {
        clearTimeout(timer);
        resolve(p);
      });
    });
  };

  let actualPort: number;
  try {
    actualPort = await waitForPort();
  } catch (e) {
    const elapsedMs = Date.now() - start;
    await child.kill();
    const stderrTail = tail(child.readStderr(), STDIO_TAIL_BYTES);
    const stdoutTail = tail(child.readStdout(), STDIO_TAIL_BYTES);
    log("error", {
      event: "launch_timeout",
      elapsedMs,
      port: -1,
      reason: e instanceof Error ? e.message : String(e),
    });
    throw new Error(
      `bun-mot launch timeout after ${elapsedMs}ms (last attempted: port=unknown / stdout から port を抽出できず)\n` +
        `--- stdout (tail ${stdoutTail.length}B) ---\n${stdoutTail}\n` +
        `--- stderr (tail ${stderrTail.length}B) ---\n${stderrTail}`,
    );
  }

  // TCP 接続成立までリトライ。helper 経由で probe loop を共通化 (attach() からも同じ helper を使う)。
  // 経過時間 (helper 内で測定) を加算した「launch 全体の elapsed」をエラーメッセージに使う。
  const probeStart = Date.now();
  const probe = await waitForBridgeReady(connectAdapter, hostname, actualPort, readyTimeout);
  if (!probe.ok) {
    const elapsedMs = Date.now() - start;
    await child.kill();
    const stderrTail = tail(child.readStderr(), STDIO_TAIL_BYTES);
    const stdoutTail = tail(child.readStdout(), STDIO_TAIL_BYTES);
    log("error", {
      event: "launch_timeout",
      elapsedMs,
      port: actualPort,
      reason: "tcp_not_listening",
    });
    throw new Error(
      `bun-mot launch timeout after ${elapsedMs}ms (last attempted: ${hostname}:${actualPort})\n` +
        `--- stdout (tail ${stdoutTail.length}B) ---\n${stdoutTail}\n` +
        `--- stderr (tail ${stderrTail.length}B) ---\n${stderrTail}`,
    );
  }
  log("launch_bridge_ready", { port: actualPort, elapsedMs: Date.now() - start, probeMs: Date.now() - probeStart });

  const mot = new BunMot({
    port: actualPort,
    hostname,
    defaultTimeout: options.defaultTimeout,
  });

  let closed = false;
  const app: LaunchedApp = {
    pid: child.pid,
    port: actualPort,
    readStdout: () => child.readStdout(),
    readStderr: () => child.readStderr(),
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await child.kill();
        log("launch_closed", { pid: child.pid });
      } catch (e) {
        log("error", {
          event: "launch_close_failed",
          pid: child.pid,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };

  return { app, mot };
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * deadlineMs が経過するまで TCP connect を {@link READY_RETRY_INTERVAL_MS}ms 間隔で polling する。
 * エラーは throw しない。呼び出し側 (launch / attach) が `ok=false` を見て
 * それぞれ固有のエラーメッセージ (launch: stdout/stderr tail 込み / attach: 短い形式) を組み立てる。
 *
 * launch と attach で probe loop を 2 箇所に書くと変更時にバグが分裂するため共通化した helper。
 *
 * @internal
 */
export async function waitForBridgeReady(
  adapter: ConnectAdapter,
  hostname: string,
  port: number,
  deadlineMs: number,
): Promise<{ ok: boolean; elapsedMs: number }> {
  const start = Date.now();
  const deadline = start + deadlineMs;
  for (;;) {
    const ok = await adapter.tryConnect(hostname, port);
    if (ok) {
      return { ok: true, elapsedMs: Date.now() - start };
    }
    if (Date.now() >= deadline) {
      return { ok: false, elapsedMs: Date.now() - start };
    }
    await sleep(READY_RETRY_INTERVAL_MS);
  }
}

// process.env から undefined 値を除去 (Record<string, string> の制約を満たすため)
function filterEnv(env: LocalProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}

// ===== Adapter 実装 =====

declare const Bun: unknown;

function isBunRuntime(): boolean {
  return typeof Bun !== "undefined";
}

export function selectSpawnAdapter(): SpawnAdapter {
  if (isBunRuntime()) return bunSpawnAdapter;
  return nodeSpawnAdapter;
}

export function selectConnectAdapter(): ConnectAdapter {
  if (isBunRuntime()) return bunConnectAdapter;
  return nodeConnectAdapter;
}

const bunSpawnAdapter: SpawnAdapter = {
  spawn(cmd, opts): SpawnedProcess {
    // Bun.spawn を実行。stdout/stderr は pipe として取得し、行単位でディスパッチ。
    const bunGlobal = (globalThis as unknown as { Bun: { spawn: (...a: unknown[]) => unknown } }).Bun;
    const proc = bunGlobal.spawn([...cmd], {
      cwd: opts.cwd,
      env: opts.env,
      stdout: "pipe",
      stderr: "pipe",
    }) as {
      pid: number;
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      exited: Promise<number>;
      kill(signal?: number | string): void;
    };
    return wrapStreamingProcess({
      pid: proc.pid,
      stdoutStream: proc.stdout,
      stderrStream: proc.stderr,
      kill: (signal): void => proc.kill(signal),
      exited: proc.exited,
    });
  },
};

const nodeSpawnAdapter: SpawnAdapter = {
  spawn(cmd, opts): SpawnedProcess {
    // Node fallback。動的 require で child_process に依存 (Bun ランタイムでは未使用)。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = (eval("require") as (m: string) => unknown)("child_process") as {
      spawn: (
        command: string,
        args: string[],
        opts: { cwd: string; env: Record<string, string>; stdio: "pipe" },
      ) => {
        pid: number | undefined;
        stdout: LocalNodeReadableStream;
        stderr: LocalNodeReadableStream;
        kill(signal?: string): boolean;
        on(event: "exit", listener: (code: number | null) => void): void;
      };
    };
    const [head, ...rest] = cmd;
    if (head === undefined) throw new Error("spawn: empty command");
    const proc = cp.spawn(head, rest, { cwd: opts.cwd, env: opts.env, stdio: "pipe" });

    let exitedResolve: () => void = (): void => {};
    const exited = new Promise<number>((resolve) => {
      exitedResolve = (): void => resolve(0);
    });
    proc.on("exit", () => exitedResolve());

    return wrapNodeStreamingProcess({
      pid: proc.pid ?? -1,
      stdoutStream: proc.stdout,
      stderrStream: proc.stderr,
      kill: (signal): void => {
        proc.kill(typeof signal === "number" ? undefined : signal);
      },
      exited,
    });
  },
};

const bunConnectAdapter: ConnectAdapter = {
  tryConnect: async (hostname, port): Promise<boolean> => {
    // Bun.connect で TCP に短時間つなぎ、成立したらすぐ close。
    const bunGlobal = (globalThis as unknown as {
      Bun: { connect: (opts: unknown) => Promise<{ end(): void }> };
    }).Bun;
    try {
      const socket = await bunGlobal.connect({
        hostname,
        port,
        socket: {
          data(): void {},
          open(): void {},
          close(): void {},
          drain(): void {},
          error(): void {},
        },
      });
      socket.end();
      return true;
    } catch {
      return false;
    }
  },
};

const nodeConnectAdapter: ConnectAdapter = {
  tryConnect: async (hostname, port): Promise<boolean> => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = (eval("require") as (m: string) => unknown)("net") as {
      createConnection: (
        opts: { host: string; port: number; timeout?: number },
        listener?: () => void,
      ) => {
        once(event: string, listener: (e?: unknown) => void): void;
        end(): void;
        destroy(): void;
        setTimeout(ms: number): void;
      };
    };
    return await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host: hostname, port });
      sock.setTimeout(500);
      sock.once("connect", () => {
        sock.end();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
      sock.once("timeout", () => {
        sock.destroy();
        resolve(false);
      });
    });
  },
};

// ===== streaming process helper (Bun ReadableStream) =====

interface StreamingProcessInit {
  pid: number;
  stdoutStream: ReadableStream<Uint8Array>;
  stderrStream: ReadableStream<Uint8Array>;
  kill: (signal?: number | string) => void;
  exited: Promise<unknown>;
}

function wrapStreamingProcess(init: StreamingProcessInit): SpawnedProcess {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const stdoutLineHandlers: Array<(line: string) => void> = [];
  const stderrLineHandlers: Array<(line: string) => void> = [];

  void pumpStream(init.stdoutStream, (line) => {
    stdoutBuf.push(line + "\n");
    for (const h of stdoutLineHandlers) h(line);
  });
  void pumpStream(init.stderrStream, (line) => {
    stderrBuf.push(line + "\n");
    for (const h of stderrLineHandlers) h(line);
  });

  let alive = true;
  void init.exited.then(() => {
    alive = false;
  });

  return {
    pid: init.pid,
    onStdoutLine: (h): void => {
      stdoutLineHandlers.push(h);
    },
    onStderrLine: (h): void => {
      stderrLineHandlers.push(h);
    },
    readStdout: (): string => stdoutBuf.join(""),
    readStderr: (): string => stderrBuf.join(""),
    isAlive: (): boolean => alive,
    kill: async (): Promise<void> => {
      if (!alive) return;
      try {
        init.kill("SIGTERM");
      } catch (e) {
        // 既に死んでいる等の expected failure
        log("launch_kill_skipped", {
          runtime: "bun",
          signal: "SIGTERM",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
      const killed = await Promise.race([
        init.exited.then(() => true),
        sleep(1500).then(() => false),
      ]);
      if (!killed) {
        try {
          init.kill("SIGKILL");
        } catch (e) {
          log("launch_kill_skipped", {
            runtime: "bun",
            signal: "SIGKILL",
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }
      alive = false;
    },
  };
}

async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        onLine(line);
      }
    }
    if (pending.length > 0) onLine(pending);
  } catch (e) {
    log("error", {
      event: "launch_stream_pump_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    try {
      reader.releaseLock();
    } catch (e) {
      // ストリーム解放済み等の expected failure
      log("launch_release_lock_skipped", {
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// ===== Node ReadableStream wrapper =====

interface NodeStreamingProcessInit {
  pid: number;
  stdoutStream: LocalNodeReadableStream;
  stderrStream: LocalNodeReadableStream;
  kill: (signal?: number | string) => void;
  exited: Promise<unknown>;
}

function wrapNodeStreamingProcess(init: NodeStreamingProcessInit): SpawnedProcess {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const stdoutLineHandlers: Array<(line: string) => void> = [];
  const stderrLineHandlers: Array<(line: string) => void> = [];

  pumpNodeStream(init.stdoutStream, (line) => {
    stdoutBuf.push(line + "\n");
    for (const h of stdoutLineHandlers) h(line);
  });
  pumpNodeStream(init.stderrStream, (line) => {
    stderrBuf.push(line + "\n");
    for (const h of stderrLineHandlers) h(line);
  });

  let alive = true;
  void init.exited.then(() => {
    alive = false;
  });

  return {
    pid: init.pid,
    onStdoutLine: (h): void => {
      stdoutLineHandlers.push(h);
    },
    onStderrLine: (h): void => {
      stderrLineHandlers.push(h);
    },
    readStdout: (): string => stdoutBuf.join(""),
    readStderr: (): string => stderrBuf.join(""),
    isAlive: (): boolean => alive,
    kill: async (): Promise<void> => {
      if (!alive) return;
      try {
        init.kill("SIGTERM");
      } catch (e) {
        // 既に死んでいる等の expected failure
        log("launch_kill_skipped", {
          runtime: "node",
          signal: "SIGTERM",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
      const killed = await Promise.race([
        init.exited.then(() => true),
        sleep(1500).then(() => false),
      ]);
      if (!killed) {
        try {
          init.kill("SIGKILL");
        } catch (e) {
          log("launch_kill_skipped", {
            runtime: "node",
            signal: "SIGKILL",
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }
      alive = false;
    },
  };
}

function pumpNodeStream(
  stream: LocalNodeReadableStream,
  onLine: (line: string) => void,
): void {
  let pending = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | LocalBuffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    pending += text;
    let idx: number;
    while ((idx = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (pending.length > 0) onLine(pending);
  });
}
