// Production ビルドで bun-mot/bridge を除外するパターンの最小実証用エントリ。
//
// 推奨パターン:
// (1) 環境変数 BUN_MOT_PORT のガードで bridge を import するかを切り替える (動的 import)
// (2) bundler が `process.env.BUN_MOT_PORT` を build 時に静的置換 (Bun bundler は
//     `--env='BUN_MOT_*'` で identifier アクセス形式を文字列リテラルにインライン化する)
//     → ガード条件が定数 false に折り畳まれ、未到達コードとして tree-shake される
//
// 本 fixture は test/integration/prod-build.test.ts から `bun build --target=bun`
// (minify なし) で 2 通り (env 空 / env 値あり) ビルドされる。env 空のビルドでは
// 出力に `setupBunMot` / 内部リテラル (`command_received`) が含まれないこと、
// env 値ありビルドでは含まれることを assertion する。

declare const process: {
  env: Record<string, string | undefined>;
};

async function main(): Promise<void> {
  // identifier アクセス形式 (`process.env.BUN_MOT_PORT`) は Bun bundler の `--env=BUN_MOT_*`
  // による build-time 文字列リテラル置換の対象。bracket アクセス (`process.env["..."]`) は
  // 置換されないので使わない。
  if (process.env.BUN_MOT_PORT) {
    const { setupBunMot } = await import("../../../src/bridge");
    const port = Number(process.env.BUN_MOT_PORT);
    // テスト fixture では view を渡さない (構築だけで bridge コードが bundle に含まれるかの検証用)。
    // 実利用では Electrobun の BrowserWindow.webview を渡す。
    setupBunMot({} as never, { port });
  }
  console.log("prod-build fixture: app started");
}

void main();

// `declare const process` を module スコープに閉じ込めるため (global 汚染回避) export を付ける。
export {};
