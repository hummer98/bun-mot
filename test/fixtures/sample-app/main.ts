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
      // 最小スタブ: 受け取った script を eval する。
      // scripts.ts 由来の document.querySelector を含む script は ReferenceError で reject され、
      // bridge 側で `evaluation_error` に分類される (本フィクスチャのスコープ外)。
      evaluateJavascriptWithResponse: async (script: string): Promise<unknown> => {
        // eslint-disable-next-line no-eval
        return eval(script);
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
