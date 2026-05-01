# mado への bun-mot 組み込み手順

`bun-mot` を mado アプリで E2E テストするには、mado 側に bridge 起動コードを 1 箇所追加する必要がある。
本ドキュメントは **mado リポジトリで別 PR として実施する変更**の最小 diff を記録する。
bun-mot リポジトリ自体は mado への変更を含まない (依存方向の逆転を避けるため)。

## ねらい

- 開発時 (`BUN_MOT_PORT` を立てて起動した時) のみ `setupBunMot` を呼び、HTTP bridge を listen させる
- Production ビルドでは bridge 関連コードが **bundle に含まれない**ようにする (動的 import + 環境変数ガード)

## 必要な変更 (mado 側)

`mado/src/bun/index.ts` (もしくは Electrobun の Bun エントリ相当) に以下のスニペットを追加する。

```typescript
// (既存) BrowserWindow を構築する箇所の後
const win = new BrowserWindow({ url: "views://my-app/index.html" /* ... */ });

// === bun-mot bridge 起動 (dev 時のみ) ===
// 動的 import + 環境変数ガード。Production ビルドでは bundler が
// `process.env.BUN_MOT_PORT` を空文字列にインライン置換して `if ("")` に折り畳み、
// `import("bun-mot/bridge")` ごと dead-code として除去する。
if (process.env.BUN_MOT_PORT) {
  const { setupBunMot } = await import("bun-mot/bridge");
  const port = Number(process.env.BUN_MOT_PORT);
  const motBridge = setupBunMot(win.webview, { port });
  process.on("SIGTERM", () => motBridge.stop());
  process.on("SIGINT", () => motBridge.stop());
  // bun-mot/launch が `fixture-bridge-ready port=NNNN` を読み取るため、stdout に必ず出力する
  console.log(`fixture-bridge-ready port=${motBridge.port}`);
}
```

## ビルド設定 (mado 側)

mado の Production ビルドコマンドで Bun bundler を使う場合、以下のオプションを付与する。

```bash
# Production (bun-mot 関連を bundle から除去)
bun build --target=bun --env='BUN_MOT_*' src/bun/index.ts

# 開発 / E2E テスト時 (bridge を bundle に含める or 動的解決)
BUN_MOT_PORT=0 bun build --target=bun --env='BUN_MOT_*' src/bun/index.ts
```

`--env='BUN_MOT_*'` は `process.env.BUN_MOT_PORT` のような identifier アクセスを build 時の文字列リテラルに置換する。
未注入時 (`BUN_MOT_PORT` が unset) は `process.env.BUN_MOT_PORT` が空文字列に置換され、ガード条件が定数 false に折り畳まれる。

> **注意**: `process.env["BUN_MOT_PORT"]` (bracket access) は置換対象外。必ず identifier アクセス (`process.env.BUN_MOT_PORT`) を使うこと。

## package.json (mado 側)

`bun-mot` を devDependency として追加する。

```json
{
  "devDependencies": {
    "bun-mot": "^0.1.0"
  }
}
```

## 動作確認 (bun-mot 側 smoke スクリプト)

mado 側に上記 diff がマージされた後、bun-mot リポジトリで以下を実行する:

```bash
MADO_DIR=/path/to/mado bun run mado:smoke
```

スモークスクリプト (`bun-mot/scripts/smoke-mado.ts`) は以下を順に確認する:

1. `MADO_DIR` の存在確認 + `src/bun/index.ts` 内の `setupBunMot` 呼び出し検出
2. `bun run dev` (Electrobun dev) を `BUN_MOT_PORT=0` で起動
3. stdout から `fixture-bridge-ready port=NNNN` を読み取り bridge 接続待ち
4. `.mermaid svg` の表示、`h1` の取得、`document.title` の取得を assertion
5. `mot.pass()` で完了 → `app.close()`

**実行環境必須要件**: macOS GUI 環境 (mado のウィンドウが立ち上がる)。SSH / ヘッドレス環境では実行不可。

## TODO (本ドキュメント整備時の前提)

- mado 側 `src/bun/index.ts` の正確なファイルパスと既存の BrowserWindow 構築箇所の位置確認
  (mado 側 PR 作成時に実コードに合わせて diff を最終化する)
- mado の `package.json` build script の現状確認 (`--env='BUN_MOT_*'` が既に入っているか)
