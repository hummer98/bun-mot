# test/fixtures/sample-app

bun-mot の `launch()` helper の **統合テスト用フィクスチャ**。

## 位置づけ

- **Electrobun アプリではない**。Bun スクリプトとして直接実行できる "起動可能な mock bridge"。
- 本物の `setupBunMot` を経由するため、`launch()` の経路 (env 注入 → spawn → stdout からの port 抽出 → TCP wait → BunMot 構築) を実装そのままで通せる。
- WebView の代わりに `eval` ベースのダミー view を渡している。`mot.evaluate("1")` のような単純な式は通るが、`scripts.ts` 由来の `document.querySelector(...)` を含む script は `ReferenceError` で reject されて bridge 側で `evaluation_error` に分類される。

## 手動起動

```bash
BUN_MOT_PORT=0 bun run test/fixtures/sample-app/main.ts
```

stdout に以下のマーカー行が出る:

```
fixture-bridge-ready port=NNNN
```

`launch()` はこの行を `/fixture-bridge-ready port=(\d+)/` で抽出して TCP 接続を試みる。

## 将来 (T005)

実 Electrobun アプリ (実 DOM を持ち、`scripts.ts` 由来の Promise script も実行できる) に置き換える予定。
