# bun-mot

[English](../README.md) | **日本語**

E2E testing driver for [Electrobun](https://electrobun.dev/) apps. バンの車検のように、Electrobun アプリを検査する。 🚐✅

```typescript
import { BunMot } from "bun-mot";

const mot = new BunMot({ port: 4747 });
await mot.waitForSelector(".mermaid svg");
const heading = await mot.getText("h1");
```

## なぜ bun-mot か

Electrobun には公式の E2E テストドライバが存在せず、エコシステムにも汎用的な選択肢がない。npm / JSR / GitHub を「Electrobun」「test」で検索しても汎用 framework は見つからない。Playwright の `connectOverCDP()` も Electrobun の OOPIF (out-of-process iframe) モデルと構造的に非互換で、attach 時のページナビゲーションが Electrobun 側の RPC 登録を破壊する。コミュニティ実装 (canter, agent-electrobun) もメンテ停止か特定アプリ専用にとどまる。

bun-mot は HTTP bridge という素朴な発想でこの空白を埋める。CDP を話すのではなく、テスト対象のアプリの中に小さな HTTP サーバを同梱し、WKWebView へは `view.rpc.request.evaluateJavascriptWithResponse(...)` で命令を流す。テストプロセスは型付きコマンドを POST し、bridge が WebView 内で評価し、結果は JSON で返る。テストコードとアプリは疎結合のまま、Electrobun 標準の RPC 配管にそのまま乗れる。

API の手触りは意図的に Playwright に揃えている (`waitForSelector` / `getText` / `click` / `fill` / `screenshot`)。新しい学習は不要。名前は遊び心: **bun** は Bun ランタイムであり、同時に「バン (van)」とも読める。**MOT** は英国の車両検査制度。`mot.pass()` を呼ぶとバンが車検に合格して 🚐✅ が出る。詳細な設計判断は [docs/design.md](design.md) を参照。

## インストール

```bash
bun add bun-mot
```

## 使い方

bun-mot は **アプリ側 (Electrobun アプリ内で動かす HTTP bridge)** と **テスト側 (`BunMot` クライアント)** の 2 つから構成される。

### 1. アプリ側: bridge を起動する

Electrobun アプリの起動コードに `setupBunMot` を **動的 import + 環境変数ガード**で組み込む。
これにより Production ビルドでは `bun-mot/bridge` ごと bundle から除去できる
(詳細は [Production ビルド除外](#production-ビルド除外) を参照)。

```typescript
// app/main.ts
import { BrowserWindow } from "electrobun/bun";

const win = new BrowserWindow({
  url: "views://my-app/index.html",
});

// 動的 import + 環境変数ガード:
// (1) BUN_MOT_PORT が立っている時だけ bridge を import する
// (2) bundler が `process.env.BUN_MOT_PORT` を build 時に文字列リテラルへ静的置換すれば、
//     Production ビルドではガードが定数 false に折り畳まれて dead-code 除去される
if (process.env.BUN_MOT_PORT) {
  const { setupBunMot } = await import("bun-mot/bridge");
  const port = Number(process.env.BUN_MOT_PORT);
  const mot = setupBunMot(win.webview, { port });
  // launch() 側が読み取るマーカー行 (TOCTOU 回避のため stdout 経由で port を伝える)
  console.log(`fixture-bridge-ready port=${mot.port}`);
  process.on("SIGTERM", () => mot.stop());
}
```

> **注意**: bracket access (`process.env["BUN_MOT_PORT"]`) ではなく **identifier アクセス** (`process.env.BUN_MOT_PORT`) を使うこと。
> Bun bundler の `--env='BUN_MOT_*'` による build-time インライン置換は identifier アクセス形式のみを対象とする。

`view` 引数は以下のインタフェースを満たすオブジェクト。Electrobun の `BrowserView` / `webview` がそのまま渡せる。

```typescript
interface BunMotView {
  rpc: {
    request: {
      evaluateJavascriptWithResponse(script: string): Promise<unknown>;
    };
  };
}
```

### 2. テスト側: BunMot クライアントから操作する

```typescript
import { BunMot } from "bun-mot";

const mot = new BunMot({ port: 4747 });

// セレクターが現れるまで待つ (MutationObserver ベース、デフォルト 5000ms)
await mot.waitForSelector(".mermaid svg");

// テキスト取得
const heading = await mot.getText("h1");

// 任意の式を評価
const title = await mot.evaluate("document.title");

// スクリーンショット (path 指定でファイル書き出し)
await mot.screenshot("./screenshots/result.png");

// path 省略で Buffer を受け取り、画像処理に渡す
const { buffer, byteCount } = await mot.screenshot();
console.log(`captured ${byteCount} bytes`);

// body スコープのみを撮影
await mot.screenshot("./body-only.png", { fullPage: false });

// 全アサーション成功を user-facing に表示する
await mot.pass("Mermaid renders");
// → 🚐✅ bun-mot: all assertions passed (Mermaid renders)
```

### 3. テスト側: `launch()` でアプリを起動する

`bun-mot/launch` は **アプリ spawn → bridge 接続待ち → BunMot 構築** を 1 行で行う helper。
bun:test / Vitest の双方からそのまま使える (テストフレームワーク中立)。

```typescript
// bun:test の例
import { test, expect } from "bun:test";
import { launch } from "bun-mot/launch";

test("ホーム画面の見出しが表示される", async () => {
  const { app, mot } = await launch({
    appPath: "./apps/my-app/main.ts",
    readyTimeout: 10_000,
  });
  try {
    await mot.waitForSelector("h1");
    expect(await mot.getText("h1")).toBe("Hello");
    await mot.pass();
  } finally {
    await app.close();
  }
});
```

```typescript
// Vitest の例 (Vitest は user 側で別途 install してください)
import { test, expect } from "vitest";
import { launch } from "bun-mot/launch";

test("ホーム画面の見出しが表示される", async () => {
  const { app, mot } = await launch({ appPath: "./apps/my-app/main.ts" });
  try {
    await mot.waitForSelector("h1");
    expect(await mot.getText("h1")).toBe("Hello");
  } finally {
    await app.close();
  }
});
```

`launch()` の動作:

1. 子プロセスに `BUN_MOT_PORT` を env で渡す (デフォルト `0` で空きポートを子に決めさせる)。
2. 子の stdout から `fixture-bridge-ready port=NNNN` 形式のマーカー行を抽出して実 port を確定する (TOCTOU を避けるため `net.createServer(0)` 方式は採らない)。
3. 抽出した port に TCP 接続が成立したら `BunMot` を構築して返す。
4. `app.close()` は SIGTERM → 1.5s 経過で SIGKILL。冪等 (二度呼んでも安全)。

`readyTimeout` 経過で reject される場合、エラーメッセージには **経過 ms / 最後の接続先 / stdout・stderr の末尾** が含まれる。

### 4. 複数 view と `view()` の v1 制限

Electrobun アプリは **複数の BrowserView** を持てる (各 view は独立した HTML/DOM)。
`mot.view(name)` は v1 で API シグネチャだけ提供し、リクエスト body に `viewId` を自動で乗せる。

```typescript
const main = mot.view("main");
await main.waitForSelector(".mermaid svg");
const heading = await main.getText("h1");
```

`view()` の連鎖は **replace 方式 (最後の name が勝つ)**:

```typescript
mot.view("a").view("b").evaluate("1");
// 送られる viewId は "b"
```

**v1 制限**: bridge 側は単一 view にしか向かないため、現時点では複数 view への切替は機能しない。
複数 view 対応は将来の統合テストで実証予定。`view()` API は将来互換のためのプレースホルダ。

### 環境変数

| 環境変数 | 用途 |
|---|---|
| `BUN_MOT_PORT` | bridge を起動するポート番号 (アプリ側 README 例で参照) |
| `BUN_MOT_LOG=silent` | bun-mot 自身のロギングを抑制 (テスト時に便利) |

## API

### `setupBunMot(view, options)`

アプリ側で HTTP bridge を起動する。

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `view` | `BunMotView` | ✓ | `evaluateJavascriptWithResponse` を持つオブジェクト |
| `options.port` | `number` | ✓ | バインドするポート (`0` でランダム割当) |
| `options.hostname` | `string` |  | バインド先ホスト (デフォルト `127.0.0.1`) |
| `options.chunkTimeoutMs` | `number` |  | wait 系 chunk loop の 1 チャンク内 timeout (ms, デフォルト `5000`)。詳細は [長時間 wait](#長時間-wait-electrobun-preload-の-10s-ws-制限) 参照 |

戻り値: `{ port: number, stop(): void }`

### `new BunMot(options)`

テスト側のクライアント。

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `options.port` | `number` | ✓ | bridge のポート |
| `options.hostname` | `string` |  | bridge のホスト (デフォルト `127.0.0.1`) |
| `options.defaultTimeout` | `number` |  | `waitForSelector` 等のデフォルトタイムアウト (ms, デフォルト `5000`) |
| `options.viewId` | `string` |  | 複数 view 対応用に予約。指定するとすべてのリクエストに `viewId` フィールドが自動付与される (v1 では bridge は無視) |

#### メソッド

| メソッド | 説明 | 戻り値 |
|---|---|---|
| `evaluate(expression)` | 任意の式を WebView 上で評価 | `Promise<unknown>` |
| `waitForSelector(selector, options?)` | セレクターが現れるまで待つ (MutationObserver) | `Promise<void>` |
| `getText(selector)` | セレクター要素の `textContent` を取得 | `Promise<string>` |
| `click(selector)` | 要素を `el.click()` する | `Promise<void>` |
| `fill(selector, value)` | `<input>` / `<textarea>` に値を入力 (native setter + `input` / `change` イベント) | `Promise<void>` |
| `waitForHidden(selector, options?)` | 要素が非表示 / DOM から消えるまで待つ | `Promise<void>` |
| `waitForText(selector, text, options?)` | `text` (string または RegExp) が `textContent` に現れるまで待つ | `Promise<void>` |
| `isVisible(selector)` | 要素が可視か (display / visibility / opacity / 0x0 rect で判定) | `Promise<boolean>` |
| `getAttribute(selector, attribute)` | 属性値を取得。属性なしは `null` | `Promise<string \| null>` |
| `getLogs()` | バッファ内の console ログを取得しバッファをクリア | `Promise<ConsoleLogEntry[]>` |
| `screenshot(path?, options?)` | WebView 内 DOM を PNG として撮影。`path` 指定時はファイル書き出し、省略時は Buffer 返却 | `Promise<{ path, byteCount } \| { buffer, byteCount }>` |
| `view(name)` | 指定 view にスコープしたハンドルを返す (v1 制限あり、§「複数 view と view() の v1 制限」参照) | `BunMotScopedView` |
| `pass(message?)` | 🚐✅ bun-mot 合格表示。`Promise<void>` を返すため `await` 必須。`BUN_MOT_LOG=silent` でも常に出力される (user-facing) | `Promise<void>` |

`waitFor*` 系の `options.timeout` 未指定時は `defaultTimeout` (`5000ms`) が使われる。

`screenshot` の `options`:

| キー | 型 | 既定 | 説明 |
|---|---|---|---|
| `fullPage` | `boolean` | `true` | `true` で `document.documentElement`、`false` で `document.body` を対象 |

> Playwright との差異: bun-mot の `screenshot(path?, options?)` は `path` を**第 1 引数の string** として受け取る (Playwright は `screenshot({ path, ... })` の option-bag 形式)。

`BunMotScopedView` は `BunMot` と同じコマンドメソッド群 (`evaluate` / `waitForSelector` / `getText` / `click` / `fill` / `waitForHidden` / `waitForText` / `isVisible` / `getAttribute` / `getLogs` / `view`) を持つ。`view()` を chain した場合は **replace 方式** (最後の name が勝つ) で、`mot.view('a').view('b')` の `viewId` は `'b'`。`screenshot` は scoped view では未提供 (v1 では `BunMot` のみで利用可)。

### `launch(options)` (`bun-mot/launch`)

アプリの spawn から bridge 接続成立、`BunMot` 構築までを一括で行う helper。

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `options.appPath` | `string` | ✓ | 起動する実行ファイルのパス |
| `options.args` | `string[]` |  | appPath に渡す追加 argv |
| `options.cwd` | `string` |  | spawn の cwd (デフォルト `process.cwd()`) |
| `options.env` | `Record<string,string>` |  | 子に渡す env (process.env にマージされる)。`BUN_MOT_PORT` は launch() が自動付与 |
| `options.port` | `number` |  | bridge port。未指定なら `0` を子に渡し stdout から実 port を読み取る |
| `options.hostname` | `string` |  | bridge hostname (デフォルト `127.0.0.1`) |
| `options.readyTimeout` | `number` |  | 接続待ちタイムアウト ms (デフォルト `10000`) |
| `options.defaultTimeout` | `number` |  | 構築する `BunMot` の `defaultTimeout` |
| `options.echoOutput` | `boolean` |  | 子の stdout/stderr を test runner にエコーするか (デフォルト `false`) |
| `options.runtime` | `string` |  | 起動コマンド (デフォルト `"bun"`)。Node 等を使う場合に上書き |

戻り値: `{ app: LaunchedApp, mot: BunMot }`

`LaunchedApp` のメソッド:

- `app.close(): Promise<void>` — SIGTERM → 1.5s で SIGKILL。冪等
- `app.pid: number` — 子プロセスの PID
- `app.port: number` — 実際に listen している port (stdout から抽出)
- `app.readStdout() / app.readStderr()` — デバッグ用に capture された出力

#### エラー

すべての操作は失敗時に `BunMotError` 派生クラスを throw する。

| エラークラス | `kind` | 発生条件 |
|---|---|---|
| `BunMotTimeoutError` | `timeout` | `waitForSelector` / `waitForHidden` / `waitForText` がタイムアウト |
| `BunMotSelectorNotFoundError` | `selector_not_found` | `getText` / `click` / `fill` / `getAttribute` で要素が見つからない |
| `BunMotElementNotInteractableError` | `element_not_interactable` | `click` 対象が `HTMLElement` でない、`fill` 対象が `<input>` / `<textarea>` でない |
| `BunMotEvaluationError` | `evaluation_error` | `evaluate` の式が例外を投げた |
| `BunMotError` (基底) | `validation_error` / `internal_error` | プロトコル違反 / 内部例外 |

#### 長時間 wait (Electrobun preload の 10s WS 制限)

Electrobun 1.16 の preload (`internalRpc.request`) は `evaluateJavascriptWithResponse` 1 呼び出しあたり 10 秒の hard-coded timeout を持つ。`waitForSelector` / `waitForHidden` / `waitForText` で 10 秒を超える `timeout` を扱えるよう、bun-mot bridge は wait 系コマンドを **チャンク (デフォルト 5 秒)** に分割し、ループで再評価する。`MutationObserver` の即応性は 1 チャンク内で維持しつつ、全体の wait は呼び出し側が指定した `timeout` まで延長できる。driver 側 API と wire-format (`{ found: true }` / `BunMotTimeoutError` のメッセージ) はそのまま (互換)。

`setupBunMot({ chunkTimeoutMs })` で **アプリ側** で調整する:

```typescript
// app/main.ts
import { setupBunMot } from "bun-mot/bridge";
setupBunMot(view, { port, chunkTimeoutMs: 5000 });
```

| オプション | デフォルト | 変更が必要な場合 |
|---|---|---|
| `chunkTimeoutMs` | `5000` | Electrobun preload の挙動が変わったときに調整。`8000` を超える値は preload の 10 秒制限に当たるリスクが上がる。`> 0` 必須 |

各チャンクは `wait_chunk_completed` ログイベントを発火する (`type=` / `selector=` / `matched=` / `chunkElapsedMs=` / `totalElapsedMs=` / `thisChunkMs=`)。全体 timeout 到達時は `wait_total_timeout` を発火 (`timeoutMs=` / `totalElapsedMs=` / `chunks=`)。

## Console Logs

bun-mot は WebView 内の `console.log` / `console.warn` / `console.error` を自動で in-memory バッファに記録する。

### 仕様

- **バッファ上限**: 1000 件 (FIFO で古いものから drop)。drop 発生時、`getLogs()` の戻り値先頭に warn エントリ `[bun-mot] dropped N earlier log entries` が挿入される。
- **patch のタイミング**: bridge 起動後の **最初のコマンド受信時** に lazy 注入される。以降、各コマンド前に存在チェックが走り、navigation / reload で patch が消えていれば自動再注入される。
- **取得後クリア (consume-on-read)**: `getLogs()` 呼び出し時に内部バッファはクリアされる。
- **エントリ shape**: `{ level: 'log' | 'warn' | 'error'; message: string; timestamp: number }` (`timestamp` は ms epoch)。
- **引数の文字列化**: `String(arg)` ベース。object / array は `JSON.stringify` で best-effort、循環参照などは `String(arg)` にフォールバック。

### 既知の制約

- patch 注入前 (= 最初のコマンドの前) の console 出力は捕捉されない。
- navigation / reload 直後の最初の `getLogs()` は patch 復旧前なので空 + 警告 warn entry を返す。回避策: 他コマンド (例: `mot.evaluate('1')`) を先に 1 回挟むことで再注入が走る。

### 対象外

- `console.info` / `console.debug` / `console.trace`
- patch 失敗時のクラッシュ伝播 (失敗してもアプリ側の `console.*` は壊れない)

## Production ビルド除外

`bun-mot/bridge` は **テスト時のみ** WebView に同居するためのコード。
Production ビルドにそのまま入れると **listen ポート / アプリ評価 RPC が露出する**ため、必ず除外する。

### 推奨: 動的 import + 環境変数ガード

[使い方 §1](#1-アプリ側-bridge-を起動する) で示したパターン。

```typescript
if (process.env.BUN_MOT_PORT) {
  const { setupBunMot } = await import("bun-mot/bridge");
  const port = Number(process.env.BUN_MOT_PORT);
  setupBunMot(view, { port });
}
```

ビルドコマンド:

```bash
# Production (bun-mot を bundle から除去)
bun build --target=bun --env='BUN_MOT_*' app/main.ts

# E2E テスト時 (bridge を同居させる)
BUN_MOT_PORT=0 bun build --target=bun --env='BUN_MOT_*' app/main.ts
```

`--env='BUN_MOT_*'` は `process.env.BUN_MOT_PORT` のような **identifier アクセス**を、build 時の文字列リテラルにインライン置換する。
未注入時は空文字列に置換され、`if ("")` に折り畳まれて未到達コードが tree-shake される。

### 実測動作 (Bun bundler, 2026-05 時点)

`bun-mot` 自身の `test/integration/prod-build.test.ts` で `bun build --target=bun --env='BUN_MOT_*'`
(**`--minify` なし**) の dead-code 除去を以下で実証している:

| ビルド時 env | 出力 size | `setupBunMot` 識別子 | bridge 内部リテラル (`"command_received"`) |
|---|---|---|---|
| `BUN_MOT_PORT=""` (未注入) | 141 bytes | **含まれない** | **含まれない** |
| `BUN_MOT_PORT="4747"` | 約 145 KB | 含まれる | 含まれる |

> `--minify` を併用すると識別子が mangle されて assertion が false-positive を起こすため、
> 検証時は **minify を外して**識別子ベースで grep すること。

### 代替パターン

bundler が動的 import の dead-code 除去に対応していない場合や、
`process.env` インライン置換が使えない場合は、`--define` フラグでの識別子置換を使う。

```typescript
// app/main.ts
declare const __BUN_MOT_ENABLED__: boolean;

if (__BUN_MOT_ENABLED__) {
  const { setupBunMot } = await import("bun-mot/bridge");
  setupBunMot(view, { port: 4747 });
}
```

```bash
# Production (識別子を false に置換 → if (false) → 完全削除)
bun build --target=bun --define '__BUN_MOT_ENABLED__=false' app/main.ts
# (esbuild / Vite でも同様の `--define` / `define` オプションが利用可能)
```

### 残留チェック (FAQ も参照)

Production bundle を `grep` で簡易確認できる:

```bash
grep -E "setupBunMot|command_received" dist/main.js && echo "残留あり" || echo "OK"
```

## FAQ

### Q. Production bundle に bridge が残っていないか確認したい

`grep` で識別子と内部リテラルの両方を見る:

```bash
grep -E "setupBunMot|command_received|command_validation_failed" dist/main.js
```

出力が空であれば除去できている。`--minify` を併用していると識別子が mangle されて確認できないので、
**検証目的のビルドは minify を外す**こと。

### Q. `evaluate` が `await` 付きの式で未解決のまま返ってくる

WebView 側が **`evaluateJavascriptWithResponse` の async (Promise 完了待ち)** に対応していない場合がある。
bun-mot の WaitFor 系コマンドは内部で Promise を返すスクリプトを生成するため、
Electrobun 側が同期呼び出しのみだと WaitFor が動作しない可能性がある。
最新の Electrobun 向けの async 対応版が動いているかを確認すること。

### Q. 複数 view (`mot.view("name")`) は使えるか

API シグネチャは v1 から提供しているが、bridge 側は単一 view にしか向かないため
**現時点では複数 view への切替は機能しない** (将来互換のためのプレースホルダ)。
詳細は [§4 複数 view と `view()` の v1 制限](#4-複数-view-と-view-の-v1-制限) を参照。

### Q. `bun-mot/launch` をアプリ本体に import してもよいか

**No**。`bun-mot/launch` は **テスト側専用** helper。アプリ (Electrobun のメインプロセス) からは import しないこと。
内部で Node fallback (`child_process` の動的 require) を持っており、誤って bundle に含めると無関係なコードがアプリに混入する。

## Limitations

- **Bun ランタイム必須**: `bun-mot` は Bun 専用パッケージ (`engines.bun: ">=1.0.0"`)。
  `dist/` は ES Module (拡張子なし import) で出力されるため Node では解決できず、`Bun.serve` / `Bun.spawn` の存在も前提とする。
  `package.json` に `engines.node` は意図的に設定していない (Node でも動くと誤解させないため)。
  `src/launch.ts` 内の Node fallback コード (`eval("require")(...)`) は将来の Node 対応に備えた残置で、現状では実行されない。
- **`fill`**: `<input>` / `<textarea>` のみサポート。`<select>` / `contenteditable` は未対応。focus は呼ばない (Playwright の `fill` と差異あり)。
- **`click`**: `el.click()` を呼ぶだけで、actionability check (visible / enabled / stable / 重なり要素) は行わない。SVG 要素は `HTMLElement` でないため `element_not_interactable` になる。
- **`isVisible`**: 祖先の `opacity` を再帰的にはチェックしない (Playwright と同じ簡略化)。`aria-hidden` も対象外。
- **`waitForText`**: 要素の出現とテキスト一致を同時に待つため、selector が DOM に存在しない場合も timeout まで待機する (`selector_not_found` を投げない)。
- **`screenshot`**: 内部で [`html2canvas`](https://html2canvas.hertzen.com/) を WebView に inject する方式。詳細は [screenshot-strategy.md](screenshot-strategy.md) を参照。
  - ネイティブ chrome (タイトルバー、ツールバー、スクロールバー) は撮影されない
  - cross-origin の `<iframe>` 内部はレンダリングされない (空 or 代替テキスト)
  - `backdrop-filter` 等の一部 CSS は再現が完全でない
  - ピクセル完全な比較を必要とするビジュアルリグレッションには不向き (将来 issue で議論予定)
  - 初回撮影時のみ html2canvas (約 47KB) の inject 分のオーバーヘッドが乗る (数十〜100ms)
  - `screenshot` 限定で `test/fixtures/sample-app/` を用いた実機検証は未整備。本リリースではユニットテスト (mock) のみ
- **コンソールログ**: 上記 "Console Logs > 既知の制約" を参照。

## curl による手動検証

bridge を起動した状態で以下のリクエストを送れる。

```bash
# evaluate
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"evaluate","expression":"1+1"}'
# → {"success":true,"result":2}

# waitForSelector
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"waitForSelector","selector":".mermaid svg","timeout":5000}'
# → {"success":true,"result":{"found":true}}
# → タイムアウトの場合: {"success":false,"error":{"kind":"timeout","message":"__BUNMOT_TIMEOUT__:..."}}

# getText
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"getText","selector":"h1"}'
# → {"success":true,"result":{"text":"Hello"}}

# click
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"click","selector":".btn"}'
# → {"success":true,"result":{"clicked":true}}

# fill
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"fill","selector":"input[name=q]","value":"hello"}'
# → {"success":true,"result":{"filled":true}}

# getLogs
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"getLogs"}'
# → {"success":true,"result":{"entries":[...],"droppedCount":0,"patchMissing":false}}

# screenshot
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"screenshot","fullPage":true}'
# → {"success":true,"result":{"dataUrl":"data:image/png;base64,...","byteCount":12345}}
```

## 開発

```bash
bun install
bun test                      # ユニット + 統合テスト (デフォルト)
bun run test:unit             # 統合テスト除外 (prepublishOnly でも使われる軽量版)
bun run test:integration      # sample-app fixture を実 spawn する統合テストのみ
bun run fixture:start         # sample-app fixture を手動起動 (デバッグ用)
bun run typecheck             # TypeScript 型チェック (tsc --noEmit)
bun run build                 # dist/ に .js + .d.ts を tsc でコンパイル
```

`bun run build` は `tsconfig.build.json` (`compilerOptions.types: []`) を使い、
公開 `.d.ts` に Bun ランタイム型 (`Server<...>`, `Bun.Subprocess`) が漏出しないようにしている。

### 設計メモ

- [`docs/design.md`](design.md) はアーキテクチャ・設計判断を集約した living document。API 仕様は本 README が正、設計の「なぜ」は design.md。

## ライセンス

MIT
