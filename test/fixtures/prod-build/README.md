# test/fixtures/prod-build

`bun-mot/bridge` の Production ビルド除外パターンを `bun build --target=bun` で実証するための fixture。

`main.ts` は「動的 import + 環境変数ガード」の最小エントリ。
`test/integration/prod-build.test.ts` がこの fixture を 2 通り (env 静的置換あり/なし) でバンドルし、
未注入時は `setupBunMot` 識別子と bridge.ts 内部リテラル (`command_received` 等) が
出力に含まれないことを assertion する。

`--minify` は付けない (識別子が mangle されると false-positive を起こすため)。
