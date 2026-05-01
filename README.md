# bun-mot

E2E testing driver for [Electrobun](https://electrobun.dev/) apps. バンの車検のように、Electrobun アプリを検査する。 🚐✅

```typescript
import { BunMot } from "bun-mot";

const mot = new BunMot({ port: 4747 });
await mot.waitForSelector(".mermaid svg");
const heading = await mot.getText("h1");
```

## インストール

```bash
bun add bun-mot
```

## 使い方

bun-mot は **アプリ側 (Electrobun アプリ内で動かす HTTP bridge)** と **テスト側 (`BunMot` クライアント)** の 2 つから構成される。

### 1. アプリ側: bridge を起動する

Electrobun アプリの起動コードに `setupBunMot` を組み込む。

```typescript
// app/main.ts
import { BrowserWindow } from "electrobun/bun";
import { setupBunMot } from "bun-mot/bridge";

const win = new BrowserWindow({
  url: "views://my-app/index.html",
});

const port = Number(process.env["BUN_MOT_PORT"] ?? "4747");
const mot = setupBunMot(win.webview, { port });

// アプリ終了時に bridge を停止する
process.on("SIGTERM", () => mot.stop());
```

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
複数 view 対応は T005 以降の統合テストで実証予定。`view()` API は将来互換のためのプレースホルダ。

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

戻り値: `{ port: number, stop(): void }`

### `new BunMot(options)`

テスト側のクライアント。

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `options.port` | `number` | ✓ | bridge のポート |
| `options.hostname` | `string` |  | bridge のホスト (デフォルト `127.0.0.1`) |
| `options.defaultTimeout` | `number` |  | `waitForSelector` 等のデフォルトタイムアウト (ms, デフォルト `5000`) |
| `options.viewId` | `string` |  | T003 用に予約。指定するとすべてのリクエストに `viewId` フィールドが自動付与される (v1 では bridge は無視) |

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

## Limitations

- **`fill`**: `<input>` / `<textarea>` のみサポート。`<select>` / `contenteditable` は未対応。focus は呼ばない (Playwright の `fill` と差異あり)。
- **`click`**: `el.click()` を呼ぶだけで、actionability check (visible / enabled / stable / 重なり要素) は行わない。SVG 要素は `HTMLElement` でないため `element_not_interactable` になる。
- **`isVisible`**: 祖先の `opacity` を再帰的にはチェックしない (Playwright と同じ簡略化)。`aria-hidden` も対象外。
- **`waitForText`**: 要素の出現とテキスト一致を同時に待つため、selector が DOM に存在しない場合も timeout まで待機する (`selector_not_found` を投げない)。
- **`screenshot`**: 内部で [`html2canvas`](https://html2canvas.hertzen.com/) を WebView に inject する方式。詳細は [docs/screenshot-strategy.md](docs/screenshot-strategy.md) を参照。
  - ネイティブ chrome (タイトルバー、ツールバー、スクロールバー) は撮影されない
  - cross-origin の `<iframe>` 内部はレンダリングされない (空 or 代替テキスト)
  - `backdrop-filter` 等の一部 CSS は再現が完全でない
  - ピクセル完全な比較を必要とするビジュアルリグレッションには不向き (将来 issue で議論予定)
  - 初回撮影時のみ html2canvas (約 47KB) の inject 分のオーバーヘッドが乗る (数十〜100ms)
  - 統合テスト (`test/fixtures/sample-app/`) を用いた実機検証は未整備。本リリースではユニットテスト (mock) のみ
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
bun test               # ユニット + 統合テスト (デフォルト)
bun test:integration   # sample-app fixture を実 spawn する統合テストのみ
bun run fixture:start  # sample-app fixture を手動起動 (デバッグ用)
bun run typecheck      # TypeScript 型チェック
```

## ライセンス

MIT
