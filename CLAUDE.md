# bun-mot — AI Development Policy

E2E testing driver for Electrobun apps. バンの車検のように、Electrobun アプリを検査する。

## プロジェクト概要

```typescript
import { BunMot } from 'bun-mot'

const mot = new BunMot(app)
await mot.waitForSelector('.mermaid svg')
await mot.getText('h1')
await mot.screenshot('result.png')
await mot.pass()  // 🚐✅
```

詳細コンセプト・設計判断: `docs/design.md` を参照。

---

## Claude Code 設定

### Trust / Onboarding

`.claude/settings.json` に `skipDangerousModePermissionPrompt: true` を設定済み。
新セッション開始時のパーミッション確認プロンプトはスキップされる。

### 作業ディレクトリ

このリポジトリのルートは `~/git/bun-mot/`。
**すべての作業はこのディレクトリ内で行う。** 他リポジトリへの変更は行わない。

---

## コーディング規約

### 言語方針

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・型名・定数）**: 英語
- **コミットメッセージ**: 英語（imperative mood）

### TypeScript

- strict モードを常に有効にする（`"strict": true`）
- `any` は原則禁止。型が不明な場合は `unknown` を使い、適切に絞り込む
- スキーマ検証には **Zod** を使用する。外部入力はすべて Zod でバリデーションする
- `as` によるキャストは最終手段。型ガードで代替できる場合はそちらを優先する
- `import type` を型インポートに使用する
- 関数の返り値型は明示する（推論に任せない）

### API 設計方針

- **Playwright 互換 API を目指す**: `waitForSelector`・`getText`・`screenshot` 等、Playwright を知っている人が迷わない命名
- **非同期ファースト**: すべての操作は `Promise` を返す
- **タイムアウトは引数で指定可能**: デフォルト値を持ちつつ上書き可能にする
- **エラーメッセージは親切に**: タイムアウト時はセレクターと待機時間を含める

### ファイル構成

```
src/
├── driver.ts      # BunMot メインクラス
├── bridge.ts      # Electrobun との HTTP ブリッジ（サーバー側）
├── commands.ts    # コマンド定義（Zod スキーマ）
├── client.ts      # テストコード側クライアント
└── types.ts       # 型定義
```

---

## ロギングポリシー

### ログインターフェース

イベント名でレベルを区別する。

| イベント名パターン | 用途 | 例 |
|---|---|---|
| `error` | 操作失敗・例外 | `log("error", "waitForSelector timeout: ...")` |
| `*_failed` | 特定操作の失敗 | `log("screenshot_failed", ...)` |
| `*_started`, `*_completed` | ライフサイクルイベント | `log("bridge_started", ...)` |
| その他 | 状態変化・判断記録 | `log("selector_found", ...)` |

### 必ずログすべきイベント

1. **例外捕捉時**: `catch` で処理する場合、最低限 `log("error", ...)` で記録する
2. **コマンド送受信**: bridge 経由のコマンドはすべてログに残す（デバッグ性が命）
3. **タイムアウト発生**: セレクター・待機時間・実際の経過時間を記録する
4. **接続の確立・切断**: bridge の接続状態の変化

### 禁止事項

- **空の `catch {}`**: 必ずログを残す
- **機密情報のログ**: 認証トークン等を含めない

### フォーマット

```
[2026-04-12T10:30:00+09:00] event_name key1=value1 key2=value2
```

---

## テスト方針

bun-mot 自体のテストは以下の構成とする。

### ユニットテスト

コマンドのシリアライズ・デシリアライズ、タイムアウトロジック等を `bun:test` でテスト。

```bash
bun test
```

### 統合テスト

実際の Electrobun アプリ（`test/fixtures/sample-app/`）を起動して bun-mot 経由で操作する。

```bash
bun test:integration
```

---

## GitHub Issue 運用

### Issue を作成すべき場面

- API 設計の判断が必要な場合（Playwright との互換性 vs Electrobun 固有機能）
- `evaluateJavascriptWithResponse` の制約による回避策が必要な場合
- ドキュメントと実装の乖離

### Issue に含める情報

- **問題**: 何が起きたか
- **原因**: なぜ起きたか（分かる場合）
- **修正内容**: 具体的な変更案

---

## 判断基準

- **Playwright 互換を優先**: 既存の知識で使えることが最重要
- **「動くか？」が最優先** — 理論的な美しさより実際に動作すること
- **設計判断で迷ったら Issue を作成** してユーザーの判断を仰ぐ
