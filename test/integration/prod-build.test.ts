import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Production ビルド除外パターンの dead-code 除去を Bun bundler (`bun build --target=bun`) で実証する。
//
// 実証手順:
// 1. fixture (test/fixtures/prod-build/main.ts) は `if (process.env.BUN_MOT_PORT)` ガードで
//    動的 import (`await import("../../../src/bridge")`) を呼ぶ最小エントリ。
// 2. `bun build --target=bun --env='BUN_MOT_*'` で env をビルド時にインライン置換する。
//    BUN_MOT_PORT="" ならガード条件が `if ("")` に折り畳まれ、await import 以下が tree-shake される。
//    BUN_MOT_PORT="4747" ならインライン置換されて `if ("4747")` となり、bridge が bundle に含まれる。
// 3. minify は付けない (識別子が mangle されると識別子ベース assertion が常に true で false-positive)。

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "test", "fixtures", "prod-build", "main.ts");

interface BuildResult {
  bundlePath: string;
  bundleContent: string;
  cleanup(): void;
}

function bunBuild(envValue: string): BuildResult {
  const outDir = mkdtempSync(join(tmpdir(), "bun-mot-prod-build-"));
  const result = spawnSync(
    "bun",
    [
      "build",
      "--target=bun",
      "--env=BUN_MOT_*",
      `--outdir=${outDir}`,
      FIXTURE,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, BUN_MOT_PORT: envValue },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    rmSync(outDir, { recursive: true, force: true });
    throw new Error(
      `bun build failed (status=${result.status})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  const bundlePath = join(outDir, "main.js");
  const bundleContent = readFileSync(bundlePath, "utf8");
  return {
    bundlePath,
    bundleContent,
    cleanup: () => rmSync(outDir, { recursive: true, force: true }),
  };
}

describe("Production ビルド除外パターン (Bun bundler dead-code elimination)", () => {
  test("BUN_MOT_PORT 空のビルドでは setupBunMot / 内部リテラルが含まれない", () => {
    const built = bunBuild("");
    try {
      // setupBunMot 識別子が含まれないこと (= bridge.ts ごと tree-shake)
      expect(built.bundleContent).not.toContain("setupBunMot");
      // bridge.ts の特徴的な内部リテラルが含まれないこと
      expect(built.bundleContent).not.toContain("command_received");
      expect(built.bundleContent).not.toContain("command_validation_failed");
      // ガード条件が空文字列に折り畳まれていることの確認 (sanity)
      expect(built.bundleContent).toContain('if ("")');
    } finally {
      built.cleanup();
    }
  });

  test("BUN_MOT_PORT=4747 のビルドでは setupBunMot / 内部リテラルが含まれる (sanity)", () => {
    const built = bunBuild("4747");
    try {
      expect(built.bundleContent).toContain("setupBunMot");
      expect(built.bundleContent).toContain("command_received");
    } finally {
      built.cleanup();
    }
  });
});
