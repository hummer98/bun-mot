# Screenshot 実装戦略

bun-mot の `BunMot.screenshot()` がどう動いているかと、なぜこの方式を選んだかの要約。
詳細な調査経緯は `.team/tasks/004-screenshot/runs/*/research.md` を参照。

## 採用案: html2canvas を WebView 内に inject する

```
driver:    POST /command { type: "screenshot", fullPage }
bridge:    evaluateJavascriptWithResponse(`<inject html2canvas + run + return dataURL>`)
              ↓
WKWebView: html2canvas(target) → canvas.toDataURL("image/png")
              ↑ "data:image/png;base64,iVBORw0KG..."
bridge:    base64 文字列を bridge → driver にそのまま転送 (JSON 文字列)
driver:    base64 部分を decode → fs.writeFile(path, buffer) (path 指定時)
```

ライブラリ本体 (`html2canvas/dist/html2canvas.min.js`、約 47KB) は Bun の attribute import
(`with { type: "text" }`) でビルド時に文字列として読み込み、生成 JS の冒頭にそのまま埋め込む。
WebView 側で `window.__bunmot_html2canvas` が未定義のときのみ eval する冪等な inject。
bridge 側に inject 状態の state は持たず、生成 JS 内の存在チェックで担保している。

### 主な実装ファイル

| ファイル | 役割 |
|---|---|
| `src/scripts.ts` | `buildScreenshotScript({ fullPage })` で WebView 注入用 JS を組み立て (html2canvas のソースを inline) |
| `src/commands.ts` | `ScreenshotRequestSchema` / `ScreenshotResultSchema` の wire 定義 |
| `src/types.ts` | `isScreenshotResult` 型ガード |
| `src/bridge.ts` | `case "screenshot"` 分岐 + `screenshot_started` / `_completed` / `_failed` ログ |
| `src/driver.ts` | `BunMot.screenshot(path?, options?)` 公開 API。base64 decode + ファイル書き出し |
| `src/html2canvas-source.d.ts` | text import の型宣言 (`declare module ...`) |

## なぜこの方式か

1. **公開 API 制約下で実現可能な唯一の現実解**
   Electrobun の Bun-side FFI には `getWebviewSnapshot` 系の bindings が無く、ネイティブの
   `WKWebView.takeSnapshot` を呼び出す経路が存在しない (WindowsはStub、LinuxはTODO)。
   `evaluateJavascriptWithResponse` のみで完結する方式に絞るしかない。

2. **クロスプラットフォーム**
   macOS / Windows / Linux 同じコードで動く。Electrobun の Linux 対応が進んでも追加実装不要。

3. **保守性**
   `view.rpc.request.evaluateJavascriptWithResponse` は公式ドキュメントに記載された
   built-in API で互換性が約束されており、Electrobun のバージョンアップへの破壊耐性が高い。

4. **bun-mot の既存パターンと整合**
   console patch の bootstrap/ensure と同じ injection パターンで実装でき、認知コストが低い。

5. **v1 のスコープ**
   ピクセル完全性は v2 以降で `screencapture` (macOS) または Electrobun への upstream PR で
   別途追加できる (例: `mot.screenshot('out.png', { renderer: 'native' })`)。

### 採用しなかった代替案

#### macOS の `screencapture` コマンド経由

- Electrobun の `BrowserWindow.windowId` は CoreGraphics の `CGWindowID` ではないため、
  windowId 経由で撮影する手段がない。region 指定 (`-R x,y,w,h`) も座標系の正確な取得に
  Bun → CoreGraphics の FFI が必要で、現実味がない。
- macOS 限定でクロスプラットフォーム要件と矛盾する。
- macOS 14+ ではスクリーン録画権限ダイアログが必要 (CI 不向き)。
- v1 では不採用。将来 `--renderer=native` オプションとして検討余地あり。

#### Electrobun 内部 `getWebviewSnapshot` 直叩き

- `BrowserView.ptr` (`AbstractView*`) から `WKWebView*` を取り出す公開手段がない。
- `object_getInstanceVariable` 等の Objective-C runtime ハックは ABI 安定性が不安。
- macOS 専用の道に入ってしまい、長期方針 (Linux/Windows 対応) と矛盾する。
- 仮に Electrobun に upstream PR を出して `view.takeSnapshot()` が追加されたら、
  二段構え (`if ('takeSnapshot' in view) ... else /* html2canvas fallback */`) にできる余地はある。

## 制約事項 (E2E 用途で許容範囲)

| 制約 | 影響 | 対処 |
|---|---|---|
| ネイティブ chrome (タイトルバー、ツールバー) は撮れない | E2E は WebView 内 DOM が対象なので問題なし | README で明記 |
| cross-origin `<iframe>` 内部はレンダリング不可 | 同一 origin 中心の用途で許容 | README で明記 |
| `backdrop-filter` 等の一部 CSS の再現が完全でない | テスト用途では許容 | README で明記 |
| ピクセル完全性は保証しない | ビジュアルリグレッション用途には不向き | v2 で別 API 検討 |
| 初回 inject 分の数十〜100ms オーバーヘッド | OK | `screenshot_started` ログで可視化 |
| WebView 未ロード時は空白 PNG (エラーにならない) | 想定外用途 | `byteCount` の異常値を warn ログ化検討 |
| CSP `script-src 'self'` のページで html2canvas が eval/`new Function` を使えず失敗 | エラーは `evaluation_error` で透過的に伝わる | エラーメッセージから判断してもらう |
| cross-origin 画像でキャンバスが tainted、`SecurityError` | `evaluation_error` で伝播 | README で既知制限として明記 |

## エラーハンドリング

| ケース | 検出位置 | kind | 備考 |
|---|---|---|---|
| html2canvas inject 失敗 (CSP / eval 禁止) | bridge `evaluate` の reject | `evaluation_error` | 例外メッセージをそのまま伝送 |
| `useCORS` でも CORS 拒否で `SecurityError` | bridge `evaluate` の reject | `evaluation_error` | `"Tainted canvases may not be exported"` 等 |
| html2canvas Promise reject | bridge `evaluate` の reject | `evaluation_error` | reason をそのまま |
| 戻り値の shape 不一致 (`isScreenshotResult` false) | driver | `internal_error` | `screenshot: unexpected response shape: <JSON>` |
| ファイル書き込み失敗 | driver の `fs.writeFile` rejection | (raw error throw) | path をエラーメッセージに含める。`BunMotError` でラップせず Node の throw をそのまま再 throw (Playwright 互換) |

`BunMotEvaluationError` は `req.type === "evaluate"` のときのみ throw される。screenshot で
`evaluation_error` が来た場合は基底の `BunMotError(message, "evaluation_error")` が throw される。

## ロギング

| event | フィールド | タイミング |
|---|---|---|
| `screenshot_started` | `viewId, fullPage` | コマンド受信時 |
| `screenshot_completed` | `viewId, byteCount, durationMs` | dataURL 取得成功時 |
| `screenshot_failed` | `viewId, kind, message` | 失敗時 |
| `screenshot_saved` | `path, byteCount` | driver で path 書き出し成功時 |
| `screenshot_returned_buffer` | `byteCount` | driver で path 省略時 |
| `screenshot_bytecount_mismatch` | `wireByteCount, decodedByteCount` | wire の `byteCount` と decode 後 byteLength が倍以上ずれているとき (warn 相当、throw しない) |

`commandReceivedFields` の screenshot ケースでは `dataUrl` をログに含めない (サイズ・機密の両面)。

## 将来拡張用の余地

- v2: Electrobun に upstream PR (`view.takeSnapshot(): Promise<string>` の公開) を出し、
  利用可能な場合は native パスに自動切替
- v2: `--renderer=native` オプションで `screencapture` (macOS 限定) を選択可能に
- v2: `selector` オプションで特定要素の bounding box 部分のみ撮影
  (html2canvas で `cropArea` 渡し)
- v2: `type: "jpeg"` / `quality` オプション (現状は PNG 固定)
- 統合テスト整備: `test/fixtures/sample-app/` に最小 Electrobun アプリを作成し、
  `bun run test:integration` で 1KB 以上の PNG が生成されることを assert
