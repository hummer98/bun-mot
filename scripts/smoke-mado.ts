// mado アプリに対する手動スモークスクリプト。CI には組み込まない。
//
// 前提:
// - macOS GUI 環境必須 (実行すると mado のウィンドウが立ち上がる。SSH/ヘッドレスでは不可)
// - 環境変数 `MADO_DIR` で mado リポジトリのルートを指定 (必須)。作者個人 path はデフォルトにしない
// - mado 側の `src/bun/index.ts` に `setupBunMot` 呼び出しが組み込まれていること
//   (組み込み手順は docs/mado-integration.md を参照)
//
// 使い方:
//   MADO_DIR=/path/to/mado bun run mado:smoke

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../src/launch";

const REPO_ROOT = join(import.meta.dir, "..");
const MADO_DIR = process.env["MADO_DIR"];
const READY_TIMEOUT_MS = 30000;

function exitWithUsage(message: string): never {
  console.error(`[smoke-mado] ${message}`);
  console.error("");
  console.error("Usage:");
  console.error("  MADO_DIR=/path/to/mado bun run mado:smoke");
  console.error("");
  console.error(
    "MADO_DIR には mado リポジトリのルート (package.json と src/ を含むディレクトリ) を指定してください。",
  );
  process.exit(1);
}

if (!MADO_DIR || MADO_DIR.length === 0) {
  exitWithUsage("環境変数 MADO_DIR が指定されていません。");
}

if (!existsSync(MADO_DIR)) {
  exitWithUsage(`MADO_DIR=${MADO_DIR} が存在しません。`);
}

const madoBunIndexPath = join(MADO_DIR, "src", "bun", "index.ts");
if (!existsSync(madoBunIndexPath)) {
  exitWithUsage(
    `${madoBunIndexPath} が存在しません。MADO_DIR が mado リポジトリのルートを指しているか確認してください。`,
  );
}

const madoBunIndexContent = readFileSync(madoBunIndexPath, "utf8");
if (!madoBunIndexContent.includes("setupBunMot")) {
  console.error(
    "[smoke-mado] mado 側に bun-mot bridge の組み込みが見当たりません (setupBunMot 呼び出しなし)。",
  );
  console.error(
    `  ${join(REPO_ROOT, "docs", "mado-integration.md")} の手順に沿って mado 側 PR を作成・マージしてから再実行してください。`,
  );
  process.exit(1);
}

console.log(`[smoke-mado] mado 検出: ${MADO_DIR}`);
console.log("[smoke-mado] electrobun dev を BUN_MOT_PORT=0 で起動します (macOS GUI 必須)...");

// mado 側の起動コマンドは package.json の scripts に依存。
// 一般的に mado は electrobun dev を `bun run dev` で起動する想定。
// 異なる場合は MADO_DIR の package.json に合わせて調整する。
const launched = await launch({
  appPath: "run",
  args: ["dev"],
  runtime: "bun",
  cwd: MADO_DIR,
  env: { BUN_MOT_PORT: "0" },
  readyTimeout: READY_TIMEOUT_MS,
  echoOutput: true,
});

const { app, mot } = launched;

const cleanup = async (): Promise<void> => {
  await app.close().catch(() => undefined);
};

const onSignal = (sig: string): void => {
  console.error(`[smoke-mado] ${sig} 受信。後始末します...`);
  void cleanup().then(() => process.exit(130));
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

try {
  console.log(`[smoke-mado] bridge ready (port=${app.port}, pid=${app.pid})`);

  // assertion 1: Mermaid SVG が描画される
  await mot.waitForSelector(".mermaid svg", { timeout: 15000 });
  console.log("[smoke-mado] OK: .mermaid svg を検出");

  // assertion 2: h1 が取得できる
  const h1 = await mot.getText("h1");
  console.log(`[smoke-mado] OK: h1=${JSON.stringify(h1)}`);

  // assertion 3: document.title が取れる
  const title = await mot.evaluate("document.title");
  console.log(`[smoke-mado] OK: document.title=${JSON.stringify(title)}`);

  await mot.pass();
  await cleanup();
  console.log("[smoke-mado] PASSED 🚐✅");
  process.exit(0);
} catch (e) {
  console.error("[smoke-mado] FAILED:", e instanceof Error ? e.message : String(e));
  console.error("--- spawned stdout (tail 2KB) ---");
  console.error(app.readStdout().slice(-2048));
  console.error("--- spawned stderr (tail 2KB) ---");
  console.error(app.readStderr().slice(-2048));
  await cleanup();
  process.exit(1);
}
