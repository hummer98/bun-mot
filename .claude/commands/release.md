---
description: bun-mot の新バージョンをリリース (OIDC で npm publish)
allowed-tools: Bash(git *), Bash(bun *), Bash(npm *), Bash(node *), Bash(gh *), Bash(npx *), Read, Edit
---

# Release - bun-mot 新バージョンリリース

bun-mot の新バージョンをリリースするための一連の手順を Master が逐次実行する。

**引数**: `$ARGUMENTS`
- `--dry-run`: タグ push までは行うが、CI 監視を待たず手前で停止
- `<version>` (例 `0.2.0`): 指定バージョンで固定。省略時はコミット履歴から自動判定

## 前提: npmjs.com の Trusted Publisher 設定 (初回のみ)

OIDC で publish するには npmjs.com 側で **bun-mot を Trusted Publisher として登録**する必要がある。

1. https://www.npmjs.com/package/bun-mot/access (パッケージ初版を publish 後に有効) を開く
2. **Trusted Publisher** セクションで GitHub Actions を選択
3. 設定:
   - Organization or user: `hummer98`
   - Repository: `bun-mot`
   - Workflow filename: `release.yml`
   - Environment name: (空欄)
4. 保存

> **初回 publish の Catch-22**: npm の Trusted Publisher 設定はパッケージ存在後にしか登録できない。`v0.1.0` の初版だけは npmjs.com Web UI で **Manual Token** を発行 → ローカル `npm publish --provenance --access public` で実行 → その後 Trusted Publisher を設定 → `v0.1.1` 以降は CI で自動 publish。
> 既に v0.1.0 が npm に上がっている場合はこの手順をスキップしてよい。

## 実行手順

### 1. 前提条件チェック

```bash
git status --porcelain
```

未コミットの変更がある場合はユーザーに確認 → 必要なら commit してから再実行。

main ブランチで作業していることを確認:

```bash
[ "$(git branch --show-current)" = "main" ] || { echo "main に切り替えてください"; exit 1; }
git pull --ff-only origin main
```

### 2. テスト・型チェック・build

```bash
bun run typecheck
bun run test:unit
bun run build
npm publish --dry-run 2>&1 | tail -20
```

いずれかが失敗したらリリースを中断してエラーをユーザーに報告。

### 3. バージョン決定

```bash
node -p "require('./package.json').version"
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
[ -n "$LAST_TAG" ] && git log "${LAST_TAG}..HEAD" --oneline || git log --oneline -20
```

バージョンタイプの判定基準:
- **patch (0.1.1 → 0.1.2)**: `fix:` / `docs:` / `chore:` のみ
- **minor (0.1.1 → 0.2.0)**: `feat:` を含む
- **major (0.1.1 → 1.0.0)**: `BREAKING CHANGE` / `!:` を含む

ユーザーに **次のバージョンを提案して承認**を取ってから先に進む。

### 4. CHANGELOG.md 更新

`## [X.Y.Z] - YYYY-MM-DD` セクションを `## [Unreleased]` の下に追加。

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- 新機能

### Changed
- 変更

### Fixed
- 修正
```

ファイル末尾のリンク参照も更新:

```markdown
[Unreleased]: https://github.com/hummer98/bun-mot/compare/vX.Y.Z...HEAD
[X.Y.Z]: https://github.com/hummer98/bun-mot/compare/vX.Y.Z-1...vX.Y.Z
```

`Unreleased` 配下にあった項目はバージョンセクションへ移動し、`Unreleased` は空にする。

### 5. CHANGELOG コミット (`npm version` 前に必須)

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG for vX.Y.Z"
```

### 6. バージョン更新・タグ作成・push

```bash
# patch / minor / major のいずれか (3 で決めたもの)
npm version patch
```

`npm version` は以下を自動実行:
1. `package.json` の version を更新
2. git commit (タグ付きコミット `vX.Y.Z`)
3. git tag `vX.Y.Z`
4. `postversion` script で `git push && git push --tags`

`postversion` が設定済みであれば push まで自動。未設定なら手動で:

```bash
git push origin main
git push origin "v$(node -p "require('./package.json').version")"
```

### 7. CI 完走を待つ

タグ push 後、GitHub Actions の `release.yml` が以下を実行:
1. tag と `package.json` のバージョン整合検証
2. typecheck / test:unit / build
3. OIDC で `npm publish --provenance --access public`
4. CHANGELOG から該当バージョンを抽出して GitHub Release 作成

```bash
sleep 5
RUN_ID=$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch "${RUN_ID}" --exit-status
```

CI 失敗時は `gh run view ${RUN_ID} --log-failed` でログ確認 → 該当ステップを修正 → 必要に応じて [ロールバック](#ロールバック) を実施。

### 8. 完了報告

ユーザーに以下を報告:
- リリースバージョン (`vX.Y.Z`)
- npm: `https://www.npmjs.com/package/bun-mot/v/X.Y.Z`
- GitHub Release URL: `gh release view vX.Y.Z --json url --jq .url`
- 主な変更内容のサマリー (CHANGELOG から)

## ロールバック

リリース失敗時:

```bash
# ローカルタグの削除
git tag -d vX.Y.Z

# リモートタグの削除 (push 済みなら)
git push origin :refs/tags/vX.Y.Z

# version commit の取り消し (まだ push されていない場合のみ)
git reset --hard HEAD~1
```

npm publish 完了後の取消は `npm deprecate bun-mot@X.Y.Z "..."` のみ (`unpublish` は 72 時間制限 + 強い副作用)。

## クイックリファレンス

```bash
# 0. 前提
git status --porcelain && [ "$(git branch --show-current)" = "main" ]
git pull --ff-only origin main

# 1. 検証
bun run typecheck && bun run test:unit && bun run build
npm publish --dry-run

# 2. CHANGELOG 編集 → コミット
git add CHANGELOG.md && git commit -m "docs: update CHANGELOG for vX.Y.Z"

# 3. バージョン bump (postversion で自動 push)
npm version patch  # or minor / major

# 4. CI 監視
gh run watch "$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

## 注意事項

- 必ず main ブランチで実行
- バージョン番号は手動承認を得てから進める
- CHANGELOG コミットは `npm version` の前に作る (タグが古い CHANGELOG を指すのを避ける)
- `npm publish` をローカルで叩かない (OIDC で CI からのみ publish する設計)
