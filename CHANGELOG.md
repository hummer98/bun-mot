# Changelog

本プロジェクトの変更履歴は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) 形式に従う。
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を採用する。

## [Unreleased]

### TODO (publish 前にユーザー確認)

- `package.json.repository.url` を実 GitHub URL (`https://github.com/TBD/bun-mot.git` を確定値に置換) する
- `npm view bun-mot` で名前衝突がないことを最終確認したうえで `npm publish` を実行する

## [0.1.0] - 2026-05-01

初版公開準備リリース。`npm publish --dry-run` までを通すための実装。

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
  - scripts: `build` / `prepublishOnly` (`typecheck && test:unit && build`) / `test:unit` / `mado:smoke`
- `test/build/dist-shape.test.ts`: `dist/*.d.ts` に bun module の type import / triple-slash reference / `Bun.Subprocess` / `Server<` が現れないことを検証
- `test/integration/prod-build.test.ts`: 動的 import + 環境変数ガードによる Bun bundler dead-code 除去を `bun build --target=bun` (minify なし) で実証
- `test/fixtures/prod-build/`: 上記検証用の最小エントリ
- `scripts/smoke-mado.ts`: `MADO_DIR` を必須とした手動スモークスクリプト (CI 非対象)
- `docs/mado-integration.md`: mado 側で別 PR として必要な bridge 起動コードの最小 diff
- README に Production ビルド除外サンプル (推奨 + 代替パターン) と Bun bundler 実測動作のインライン記載、mado 連携セクション、FAQ、Limitations (Node 非対応の明示) を追加

### Changed

- `src/bridge.ts`: `import type { Server } from "bun"` を削除し、`Bun` を inline `declare` 化。`const server: Server<undefined> = ...` の annotation も削除し型推論に委ねる
- README に `docs/seed.md` の位置づけ (初期設計メモ・歴史的経緯記録、最新仕様は README が正) を 1 行追記

### Notes

- 本リリースは `npm publish --dry-run` 段階までで停止しており、実 publish はユーザー承認待ち
- mado への bridge 組み込みは別 PR (本タスク範囲外)。bun-mot 側の手動スモークスクリプトは mado 側 PR マージ後に手動実行する想定

[Unreleased]: https://github.com/TBD/bun-mot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TBD/bun-mot/releases/tag/v0.1.0
