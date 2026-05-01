# bun-mot — プロダクトコンセプト

> バンの車検（MOT）のように、Electrobun アプリを E2E 検査する

**bun** = Bun ランタイム ＝ バン（van）  
**mot** = Ministry of Transport test ＝ 英国の車検制度

---

## コンセプト

Electrobun には公式の E2E テストフレームワークが存在しない（2026-04 調査済み）。

`bun-mot` は Electrobun アプリを「車検に出す」ように検査できる、初の汎用 E2E ドライバーパッケージです。

```typescript
import { BunMot } from 'bun-mot'

const mot = new BunMot(app)

// Playwright ライクな API
await mot.waitForSelector('.mermaid svg')
await mot.getText('h1')
await mot.click('#submit-button')
await mot.screenshot('result.png')

await mot.pass()  // 🚐✅ 車検合格
```

---

## 背景・動機

### Electrobun における E2E の空白

Electrobun アプリのアーキテクチャを検討した際、E2E テスト基盤が完全に空白であることが判明した。

調査結果：

| 調査先 | 結果 |
|---|---|
| npm / JSR | 専用パッケージなし |
| GitHub | 汎用フレームワークなし |
| canter | 12 stars・2022年放置・実用不可 |
| agent-electrobun | Quiver アプリ専用 CLI・汎用ではない |
| Playwright connectOverCDP() | Electrobun の OOPIF と構造的に非互換 |

→ **エコシステムの空白地帯** であり、OSS として提供する価値がある。

### 既存資産：line-miniapp-sdk

`line-miniapp-sdk` は Claude Code が実装した HTTP ブリッジ型のリモート E2E 基盤。
このアーキテクチャを Electrobun 向けに移植する。

---

## アーキテクチャ

### 全体構成

```
テストコード（bun:test / Vitest）
  ↕ HTTP POST /command
BunMot クライアント（bun-mot）
  ↕ HTTP
Electrobun アプリ内 ブリッジサーバー（bun-mot が inject）
  ↕ view.rpc.request.evaluateJavascriptWithResponse()
WKWebView DOM
```

### なぜ HTTP ブリッジか

Playwright の `connectOverCDP()` は Electrobun と構造的に非互換（attach 時のページナビゲーションが Electrobun の RPC 登録と OOPIF 管理を破壊する）。

`evaluateJavascriptWithResponse()` は Promise に対応しており、非同期で DOM の状態を取得できる。これを HTTP 経由で呼び出すことで、テストコードとアプリを疎結合に保つ。

### コマンドプロトコル

```typescript
// テストコード → ブリッジサーバー
POST /command
{
  "type": "waitForSelector",
  "selector": ".mermaid svg",
  "timeout": 5000
}

// ブリッジサーバー → WKWebView
evaluateJavascriptWithResponse(`
  new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const check = () => {
      const el = document.querySelector('.mermaid svg')
      if (el) resolve(el.outerHTML)
      else if (Date.now() > deadline) reject('timeout: .mermaid svg')
      else setTimeout(check, 100)
    }
    check()
  })
`)

// レスポンス
{ "success": true, "result": { "value": "<svg>...</svg>" } }
```

### サポートするコマンド（初期）

| コマンド | 説明 |
|---|---|
| `waitForSelector(selector, timeout?)` | 要素が現れるまで待機 |
| `waitForHidden(selector, timeout?)` | 要素が消えるまで待機 |
| `getText(selector)` | テキスト内容を取得 |
| `getAttribute(selector, attr)` | 属性値を取得 |
| `isVisible(selector)` | 要素の可視性を確認 |
| `click(selector)` | クリック |
| `fill(selector, value)` | テキスト入力 |
| `evaluate(expression)` | 任意の JS を評価 |
| `screenshot(path?)` | スクリーンショット（`takeSnapshot` API 使用）|
| `getLogs()` | コンソールログを取得 |

---

## line-miniapp-sdk との対応関係

```
line-miniapp-sdk          →    bun-mot
─────────────────────────────────────────────────────
Cloud Run バックエンド    →    Electrobun アプリ内 Bun サーバー
HTTP POST /commands       →    同じ（Bun built-in HTTP サーバー）
WebView / ブラウザ        →    WKWebView
evaluateJavaScript        →    evaluateJavascriptWithResponse()
OIDC 認証                →    不要（ローカルのみ）
セッション管理            →    アプリ起動単位（簡略化）
```

---

## 使用方法（設計案）

### インストール

```bash
bun add -d bun-mot
```

### アプリ側（Electrobun）

```typescript
// main.ts
import { setupBunMot } from 'bun-mot/bridge'

const view = new BrowserView({ ... })

// テスト時のみブリッジを起動
if (process.env.BUN_MOT_PORT) {
  setupBunMot(view, { port: Number(process.env.BUN_MOT_PORT) })
}
```

### テスト側

```typescript
// app.test.ts
import { test, expect } from 'bun:test'
import { BunMot } from 'bun-mot'
import { launch } from './test-utils'

test('Mermaid が描画される', async () => {
  const { app, mot } = await launch()

  await mot.waitForSelector('.mermaid svg')
  const svg = await mot.evaluate('document.querySelector(".mermaid svg").outerHTML')
  expect(svg).toContain('<path')

  await app.close()
})

test('Hot Reload が動作する', async () => {
  const { app, mot } = await launch('test/fixtures/sample.md')

  await mot.waitForSelector('h1')
  expect(await mot.getText('h1')).toBe('Before')

  await writeFile('test/fixtures/sample.md', '# After')
  await mot.waitForText('h1', 'After')  // Hot Reload を確認
})
```

---

## 実装ロードマップ

- [ ] Phase 1: HTTP ブリッジサーバー（Electrobun 側）
- [ ] Phase 2: クライアント API（`waitForSelector`・`getText`・`evaluate`）
- [ ] Phase 3: スクリーンショット（`takeSnapshot` 連携）
- [ ] Phase 4: コンソールログ収集（`getLogs`）
- [ ] Phase 5: 統合テスト（実 Electrobun アプリでの実証）
- [ ] Phase 6: npm パッケージとして公開（`bun-mot`）
- [ ] Phase 7: ドキュメントサイト・サンプル

---

## 参考

- 移植元アーキテクチャ: line-miniapp-sdk (HTTP bridge + Zod スキーマ + WebView 評価)
