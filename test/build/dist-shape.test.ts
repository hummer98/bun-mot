import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// dist の形状検証。
//
// 観点:
// 1. tsc build pipeline (`bun run build`) が tsc エラーゼロで完走する
// 2. 期待する出力ファイル (index/bridge/launch の .js + .d.ts) が dist 配下に生成される
// 3. 公開 API の `.d.ts` に Bun ランタイム型 (`Server<...>`, `Bun.Subprocess`) や
//    bun module の type import / triple-slash reference が漏出していない
// 4. dist/index.d.ts に主要シンボルが含まれている

const ROOT = join(import.meta.dir, "..", "..");
const DIST = join(ROOT, "dist");

const PUBLIC_DTS_FILES = ["index.d.ts", "bridge.d.ts", "launch.d.ts"] as const;

const NG_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'from "bun"', pattern: /from\s+["']bun["']/ },
  { label: "<reference types=\"bun\"", pattern: /<reference\s+types=["']bun["']/ },
  { label: "Bun.Subprocess", pattern: /Bun\.Subprocess/ },
  { label: "Server<", pattern: /\bServer</ },
];

beforeAll(() => {
  // build を 1 回だけ実行して dist/ を生成。失敗したらテスト全体を fail させる。
  const result = spawnSync("bun", ["run", "build"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `bun run build failed with status ${result.status}\n` +
        `--- stdout ---\n${result.stdout ?? ""}\n` +
        `--- stderr ---\n${result.stderr ?? ""}`,
    );
  }
});

describe("dist shape", () => {
  test("dist/ に主要な .js / .d.ts が生成される", () => {
    expect(existsSync(join(DIST, "index.js"))).toBe(true);
    expect(existsSync(join(DIST, "index.d.ts"))).toBe(true);
    expect(existsSync(join(DIST, "bridge.js"))).toBe(true);
    expect(existsSync(join(DIST, "bridge.d.ts"))).toBe(true);
    expect(existsSync(join(DIST, "launch.js"))).toBe(true);
    expect(existsSync(join(DIST, "launch.d.ts"))).toBe(true);
  });

  for (const file of PUBLIC_DTS_FILES) {
    test(`${file} に bun ランタイム型が漏れていない`, () => {
      const content = readFileSync(join(DIST, file), "utf8");
      for (const { label, pattern } of NG_PATTERNS) {
        if (pattern.test(content)) {
          const matchedLine = content
            .split(/\r?\n/)
            .find((line) => pattern.test(line));
          throw new Error(
            `${file} に NG パターン "${label}" が含まれています:\n  ${matchedLine ?? "(該当行検出失敗)"}`,
          );
        }
      }
    });
  }

  test("dist/index.d.ts に主要シンボルが export されている", () => {
    const content = readFileSync(join(DIST, "index.d.ts"), "utf8");
    const expected = [
      "BunMot",
      "BunMotScopedView",
      "launch",
      "BunMotError",
      "BunMotTimeoutError",
      "BunMotSelectorNotFoundError",
    ];
    for (const symbol of expected) {
      expect(content).toContain(symbol);
    }
  });
});
