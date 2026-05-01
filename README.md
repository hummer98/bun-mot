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
```

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

- `evaluate(expression: string): Promise<unknown>` — 任意の式を WebView 上で評価
- `waitForSelector(selector: string, options?: { timeout?: number }): Promise<void>` — セレクターが現れるまで待つ (MutationObserver)
- `getText(selector: string): Promise<string>` — セレクター要素の `textContent` を取得

#### エラー

すべての操作は失敗時に `BunMotError` 派生クラスを throw する。

| エラークラス | `kind` | 発生条件 |
|---|---|---|
| `BunMotTimeoutError` | `timeout` | `waitForSelector` がタイムアウト |
| `BunMotSelectorNotFoundError` | `selector_not_found` | `getText` で要素が見つからない |
| `BunMotEvaluationError` | `evaluation_error` | `evaluate` の式が例外を投げた |
| `BunMotError` (基底) | `validation_error` / `internal_error` | プロトコル違反 / 内部例外 |

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
```

## 開発

```bash
bun install
bun test           # ユニットテスト
bun run typecheck  # TypeScript 型チェック
```

## ライセンス

MIT
