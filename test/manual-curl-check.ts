// 手動 curl 検証用スクリプト。
// `bun run test/manual-curl-check.ts` で起動し、別ターミナルから curl で叩く。
// 完了基準 §8.8 の検証用。

import { setupBunMot } from "../src/bridge";
import type { BunMotView } from "../src/types";

const view: BunMotView = {
  rpc: {
    request: {
      evaluateJavascriptWithResponse: async (script: string): Promise<unknown> => {
        // 簡易 mock: evaluate なら eval (※検証用、本番では使わない)
        if (script.startsWith("new Promise")) {
          // waitForSelector / getText の Promise script は WebView 環境がないと動かないので
          // 検証では simple resolve を返す
          if (script.includes("__BUNMOT_TIMEOUT__")) {
            return { found: true };
          }
          if (script.includes("textContent")) {
            return { text: "mock-text" };
          }
        }
        try {
          // 危険: 検証用のみ
          return Function("return " + script)();
        } catch (e) {
          throw e;
        }
      },
    },
  },
};

const port = Number(process.env["BUN_MOT_PORT"] ?? "4747");
const bridge = setupBunMot(view, { port });
console.log(`bun-mot bridge listening on http://127.0.0.1:${bridge.port}`);
console.log("Try:");
console.log(
  `  curl -X POST http://127.0.0.1:${bridge.port}/command -H 'content-type: application/json' -d '{"type":"evaluate","expression":"1+1"}'`,
);
