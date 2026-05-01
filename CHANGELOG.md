# Changelog

本プロジェクトの変更履歴は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) 形式に従う。
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を採用する。

## [Unreleased]

## [0.2.0] - 2026-05-01

slaido (Electrobun 1.16) からのフィードバック (#4, #5, #7) を反映した 2 番目のリリース。
長期 wait の実用化 (#7)、bootstrap の堅牢化 (#5)、`attach()` API の追加 (#4) が主な変更点。

### Added

- **#4**: `BunMot.attach({ port, hostname?, timeout?, defaultTimeout? })` static factory を追加。Playwright の `chromium.connectOverCDP()` 相当。外部で起動した Electrobun アプリ (例: `bun run build:dev && electrobun dev` のような複合起動コマンド) にテストから接続できる。`launch()` の単一バイナリ spawn モデルでカバーできない運用 (CI で `docker-compose up -d` 後にテスト実行など) を公式サポート
- **#4**: `mot.dispose()` が idempotent な flag-flip として実装され、以降の command method はすべて throw する。`attach()` で接続したプロセスは `dispose()` 後も生かす (caller が所有する)。`launch()` で起動した場合は従来通りプロセスを kill する
- **#4**: 内部 helper `waitForBridgeReady()` を抽出し、`launch()` / `attach()` で TCP probe ロジックを共通化
- **#5**: `setupBunMot({ bootstrapTimeoutMs })`: console patch bootstrap inject の timeout (ms)。デフォルト 5000ms (`defaultTimeout` と一致)。slow / hung な RPC reply で後続 command が blocking されるのを防ぐ
- **#7**: `setupBunMot({ chunkTimeoutMs })`: 1 チャンクあたりの内部 timeout (ms)。デフォルト 5000ms (Electrobun preload の 10 秒制限に対する 50% 安全マージン)。`<= 0` を渡すと throw する (sanity check)
- **#7**: bridge ログに `wait_chunk_completed` イベントを追加 (`type=` / `selector=` / `matched=` / `chunkElapsedMs=` / `totalElapsedMs=` / `thisChunkMs=`)
- **#7**: bridge ログに `wait_total_timeout` イベントを追加 (全体 timeout 到達時に発火、`timeoutMs=` / `totalElapsedMs=` / `chunks=`)
- **#7**: WebView 側 chunk script 内部プロトコル `WaitChunkResult` (`{ matched: boolean, elapsed: number }`) と型ガード `isWaitChunkResult` を `src/scripts.ts` から export

### Fixed

- **#7**: `waitForSelector` / `waitForHidden` / `waitForText` で `timeout > 10000` を指定しても Electrobun 1.16 preload (`internalRpc.request`) の 10 秒固定 RPC timeout で打ち切られていた問題を修正。bridge 側で wait 系コマンドを `chunkTimeoutMs` (デフォルト 5000ms) ごとのチャンクに分割し、ループで再評価することで、全体 timeout を任意の長さに拡張した。各チャンク内では引き続き `MutationObserver` (rAF フォールバック付き) で即応する。driver 側 API・wire-format (`{ found: true }` / `{ hidden: true }` / `{ matched: true }`) ・`BunMotTimeoutError` のメッセージは互換性を維持
- **#5**: bridge bootstrap の console patch inject が hung RPC reply で後続コマンドを blocking していた問題を修正。`Promise.race` で timeout を強制し、bootstrap は best-effort 化 (timeout や reject になっても後続コマンドは dispatch される)。timeout 後の `getLogs()` は `patchMissing: true` を返し続ける (bridge 再起動まで)

### Changed (internal)

- **#7**: `src/scripts.ts`: `buildWaitForSelectorScript` / `buildWaitForHiddenScript` / `buildWaitForTextScript` の WebView 側スクリプトを reshape。reject 経路を削除し、常に `{ matched, elapsed }` で resolve する形に統一。共通 helper `buildMutationWaitScript` に統合
- **#7**: `src/bridge.ts`: `dispatchCommand` の wait 系 case を `dispatchWaitChunkLoop` (chunk loop) に分離。`buildScriptForCommand` の責務を「wait 系以外の単発 evaluate 用」と明確化
- **#5**: `raceWithTimeout` helper を追加し、bootstrap inject と ensure inject 経路を `Promise.race` でラップ
- **#4**: `BunMot` クラスに `disposed` flag と `throwIfDisposed()` guard を追加。全 11 個の command method と `view()` に適用 (`pass()` のみ bridge IO がないため対象外)

## [0.1.1] - 2026-05-01

slaido (Electrobun 1.16) からのフィードバック (#1, #2, #3) を反映した緊急バグ修正リリース。
v0.1.0 は Electrobun 1.16 上で実質的に動作しなかったため、本バージョンを最初に動く版と位置付ける。

### Fixed

- **#1**: `src/scripts.ts` の全 builder が `new Function(script)()` 経由で実行されたとき結果が常に `undefined` になる問題を修正。式を `return (...);` で wrap し、Promise を返すスクリプトも `return new Promise(...);` の形に揃えた。Electrobun 1.16 builtin RPC (`api/browser/index.ts:142`) の handler に整合
- **#2**: `BunMotView.rpc.request.evaluateJavascriptWithResponse` のシグネチャを Electrobun 1.16 builtin RPC schema (`params: { script: string }`) に揃えた。`src/bridge.ts` の 3 箇所の呼び出しも `{ script }` 形に変更

### Changed (BREAKING)

- `BunMotView` 型: `evaluateJavascriptWithResponse(script: string)` → `evaluateJavascriptWithResponse(params: { script: string })`。Electrobun 1.16 の `webview` を直接渡しているコードには影響なし。独自に `view` を組み立てている場合は要修正

### Documentation

- **#3**: README §1.5 を追加し、mainview 側で `new Electroview({ rpc: Electroview.defineRPC({ handlers: { requests: {}, messages: {} } }) })` の構築が必要なことを明記。`__electrobunSendToHost()` だけ使っているアプリで bun-mot を入れたとき RPC transport が確立されず全リクエストが timeout する症状の hint を併記

### Added

- `.github/workflows/release.yml`: タグ push (`v*`) で OIDC Trusted Publishing による `npm publish --provenance --access public` を実行し、CHANGELOG から該当バージョンを抽出して GitHub Release を作成する CI
- `.claude/commands/release.md`: `/release` slash command 用のリリース手順書 (firex 方式)
- `package.json.scripts.postversion`: `npm version` 実行時に自動で `git push && git push --tags` を行う
- `README.md` (英語) を追加してデフォルトに。先頭に「Why bun-mot」セクション (動機 + 設計思想 + 名前の由来) を追記
- `docs/README.ja.md`: 既存の日本語 README を移動し、同じく「なぜ bun-mot か」セクションを追記
- `docs/design.md`: アーキテクチャ・設計判断を集約した living document (旧 `docs/seed.md` を living 化)。Why HTTP bridge / Why MutationObserver / Why html2canvas / `viewId` 予約理由などを集約

### Removed

- `docs/seed.md`: `docs/design.md` に内容を移行して削除

### Changed

- `package.json.repository.url` を確定 (`https://github.com/hummer98/bun-mot.git`)
- `mado` 連携 (`scripts/smoke-mado.ts`, `docs/mado-integration.md`, README §「mado 連携の実例」, `mado:smoke` script) を削除。bun-mot は単体プロジェクトとして公開
- ルート `.gitignore` に `.team/` および `.worktrees/` を追加 (multi-agent orchestration の作業ディレクトリ)

### Notes (運用)

- v0.1.0 は 2026-05-01 に Manual Token + 2FA でローカル publish 済み (https://www.npmjs.com/package/bun-mot/v/0.1.0)
- 以降のバージョンは npmjs.com で **Trusted Publisher** (`hummer98/bun-mot` / workflow `release.yml`) を登録した後、`/release` でタグ push → CI が OIDC で自動 publish
- v0.1.0 のみ provenance attestation なし (ローカル publish のため)。v0.1.1 以降は CI publish なので provenance 付き

## [0.1.0] - 2026-05-01

初版公開リリース。npm registry にて `bun-mot@0.1.0` として公開 (Manual Token 経由のローカル publish、provenance attestation なし)。

### Added

- MIT `LICENSE` ファイル (著作権者: Yuji Yamamoto)
- `CHANGELOG.md` (keepachangelog 形式)
- `tsconfig.build.json` を新設し、`bun run build` で `dist/*.js` + `dist/*.d.ts` を生成するパイプライン
  - `compilerOptions.types: []` により Bun ランタイム型 (`Server`, `Bun.Subprocess` 等) を public `.d.ts` に漏出させない
- `package.json` の npm 公開メタデータ整備
  - `version 0.1.0` / `description` / `license: "MIT"` / `author: "Yuji Yamamoto"` / `repository` (ダミー URL + TODO) / `keywords`
  - `main`, `types`, `exports` (`.`, `./bridge`, `./launch`, `./package.json` の 4 経路、`dist` 指向)
  - `files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"]`
  - `engines.bun: ">=1.0.0"` (`engines.node` は意図的に未指定)
  - `publishConfig.access: "public"`
  - scripts: `build` / `prepublishOnly` (`typecheck && test:unit && build`) / `test:unit`
- `test/build/dist-shape.test.ts`: `dist/*.d.ts` に bun module の type import / triple-slash reference / `Bun.Subprocess` / `Server<` が現れないことを検証
- `test/integration/prod-build.test.ts`: 動的 import + 環境変数ガードによる Bun bundler dead-code 除去を `bun build --target=bun` (minify なし) で実証
- `test/fixtures/prod-build/`: 上記検証用の最小エントリ
- README に Production ビルド除外サンプル (推奨 + 代替パターン) と Bun bundler 実測動作のインライン記載、FAQ、Limitations (Node 非対応の明示) を追加

### Changed

- `src/bridge.ts`: `import type { Server } from "bun"` を削除し、`Bun` を inline `declare` 化。`const server: Server<undefined> = ...` の annotation も削除し型推論に委ねる
- README に `docs/seed.md` の位置づけ (初期設計メモ・歴史的経緯記録、最新仕様は README が正) を 1 行追記

### Notes

- 2026-05-01 に v0.1.0 を npm に publish 済み (https://www.npmjs.com/package/bun-mot/v/0.1.0)
- Trusted Publisher (`release.yml` 経由の OIDC publish) は v0.1.0 公開後に npmjs.com 側で登録する設計

[Unreleased]: https://github.com/hummer98/bun-mot/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hummer98/bun-mot/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/hummer98/bun-mot/releases/tag/v0.1.1
[0.1.0]: https://github.com/hummer98/bun-mot/releases/tag/v0.1.0
