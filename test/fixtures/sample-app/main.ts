// 本フィクスチャは "起動可能な mock bridge"。Electrobun アプリではない。
// launch helper の経路 (env 注入 → spawn → port 抽出 → TCP wait → BunMot 構築 → コマンド往復 → kill)
// を実装そのままで通せるよう、本物の `setupBunMot` を経由する。
// 実 DOM 評価 / scripts.ts 由来の Promise script は T005 統合テスト (実 Electrobun) で確認する。

import { setupBunMot } from "../../../src/bridge";
import type { BunMotView } from "../../../src/types";

const port = Number(process.env["BUN_MOT_PORT"] ?? "0");

const dummyView: BunMotView = {
  rpc: {
    request: {
      // 最小スタブ: Electrobun 1.16 builtin の `evaluateJavascriptWithResponse` と同じ
      // `new Function(script)()` 経路で実行する (api/browser/index.ts:142 と等価)。
      // scripts.ts 由来の document.querySelector を含む script は ReferenceError で reject され、
      // bridge 側で `evaluation_error` に分類される (本フィクスチャのスコープ外)。
      evaluateJavascriptWithResponse: async ({
        script,
      }: {
        script: string;
      }): Promise<unknown> => {
        const fn = new Function(script);
        const result = fn();
        return result instanceof Promise ? await result : result;
      },
    },
  },
};

const bridge = setupBunMot(dummyView, { port });

// launch() が stdout から port を抽出するためのマーカー行 (フォーマット固定)。
// 形式は src/launch.ts の FIXTURE_READY_PATTERN と一致させること。
console.log(`fixture-bridge-ready port=${bridge.port}`);

const shutdown = (): void => {
  bridge.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
