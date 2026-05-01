// WebView (Electrobun) に注入する JS 文字列のビルダー。
// すべて Promise を返す式として組み立て、evaluateJavascriptWithResponse 経由で resolve/reject させる。
// reject 文字列は prefix で kind を識別 (§4.4)。
//
// 重要: Electrobun 1.16 の builtin extraRequestHandler は `new Function(script)()` で実行する
// (electrobun/api/browser/index.ts:142)。`new Function(body)()` は body の最後に return 文が
// 無いと結果が常に undefined になるため、各 builder は **必ず `return ...;` で値を返す形** に
// すること。consolePatch / ensurePatch のような副作用専用 IIFE のみ return 不要。

import type { TextMatcher } from "./commands";

// Step 0 で確定した text import 戦略: Bun の attribute import (`with { type: "text" }`)。
// バンドル本体 (~47KB) を起動時に文字列として読み込み、screenshot 命令時に WebView へ inject する。
// フォールバック (`fs.readFileSync(require.resolve(...))`) は probe で第一候補が動いたため不要。
import html2canvasSource from "html2canvas/dist/html2canvas.min.js" with { type: "text" };

// WebView 側 wait 系スクリプトが 1 chunk ごとに resolve する結果の形。
// bridge は dispatchWaitChunkLoop でこれを受け取って累計 elapsed を計算し、
// matched: true で wire-format (`{ found: true }` 等) に変換、
// 全体 timeout 到達で `__BUNMOT_TIMEOUT__:<selector>:<elapsed>` reject を生成する。
// chunk script は常に resolve し、reject はしない (chunk timeout は「未達」を表す通常結果)。
export interface WaitChunkResult {
  matched: boolean;
  elapsed: number;
}

export function isWaitChunkResult(value: unknown): value is WaitChunkResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { matched?: unknown; elapsed?: unknown };
  return typeof v.matched === "boolean" && typeof v.elapsed === "number";
}

// MutationObserver の wait 系を組み立てる共通 helper (chunk script generator)。
// chunk script は **常に resolve し、reject はしない** (reject 経路を持たない)。
// - predicate が true → `{ matched: true, elapsed }` で resolve
// - chunk timeout 到達 → `{ matched: false, elapsed }` で resolve
//
// bridge 側 dispatchWaitChunkLoop はこれを受け取り、累計 elapsed (Date.now() ベース) で
// 全体 timeout を管理する。matched: true なら wire-format (`{ found: true }` 等) に変換し、
// 全体 timeout 到達なら `__BUNMOT_TIMEOUT__:<selector>:<elapsed>` を bridge 自身が組み立てる。
//
// chunkTimeoutMs は WebView 側 setTimeout の長さ。Electrobun preload の 10s WS timeout を
// 回避するため bridge は chunkTimeoutMs 以下のチャンクに分割して繰り返し評価する。
interface MutationWaitOpts {
  selector: string;
  chunkTimeoutMs: number;
  // predicateBody: el を引数に取り、条件を満たすなら true を返す JS 関数本文 (例: "return el !== null;")
  predicateFnBody: string;
  // observe options を JSON にシリアライズした文字列 (例: '{ childList: true, subtree: true }')
  observeOpts: string;
  // rAF フォールバックを有効にするか
  withRaf: boolean;
}

function buildMutationWaitScript(opts: MutationWaitOpts): string {
  const sel = JSON.stringify(opts.selector);
  const t = String(opts.chunkTimeoutMs);
  const raf = opts.withRaf
    ? `\n  requestAnimationFrame(() => {\n    if (check()) done();\n  });`
    : "";
  return `return new Promise((resolve) => {
  const SELECTOR = ${sel};
  const TIMEOUT = ${t};
  const start = Date.now();

  const predicate = (el) => { ${opts.predicateFnBody} };
  const check = () => predicate(document.querySelector(SELECTOR));

  if (check()) { resolve({ matched: true, elapsed: Date.now() - start }); return; }

  let timeoutId;
  const done = () => {
    observer.disconnect();
    clearTimeout(timeoutId);
    resolve({ matched: true, elapsed: Date.now() - start });
  };
  const observer = new MutationObserver(() => {
    if (check()) done();
  });
  observer.observe(document.documentElement, ${opts.observeOpts});
${raf}
  timeoutId = setTimeout(() => {
    observer.disconnect();
    resolve({ matched: false, elapsed: Date.now() - start });
  }, TIMEOUT);
});`;
}

export function buildEvaluateScript(expression: string): string {
  // 任意式を `return (...)` で wrap して値を返す。new Function(body)() で評価される前提。
  // 値は evaluateJavascriptWithResponse が JSON シリアライズして返す (Promise なら await される)。
  return `return (${expression});`;
}

export function buildWaitForSelectorScript(
  selector: string,
  chunkTimeoutMs: number,
): string {
  // MutationObserver で DOM 変化を監視。ポーリング不可 (CLAUDE.md)。
  // rAF フォールバック 1 回のみ許容 (`withRaf: true`)。
  // chunk script は 1 chunk 内で必ず resolve する (reject なし)。bridge 側が
  // dispatchWaitChunkLoop で全体 timeout を管理する。
  return buildMutationWaitScript({
    selector,
    chunkTimeoutMs,
    predicateFnBody: "return el !== null;",
    observeOpts: "{ childList: true, subtree: true }",
    withRaf: true,
  });
}

export function buildGetTextScript(selector: string): string {
  const sel = JSON.stringify(selector);
  return `return new Promise((resolve, reject) => {
  const el = document.querySelector(${sel});
  if (!el) { reject('__BUNMOT_SELECTOR_NOT_FOUND__:' + ${sel}); return; }
  resolve({ text: el.textContent ?? '' });
});`;
}

export function buildClickScript(selector: string): string {
  const sel = JSON.stringify(selector);
  return `return new Promise((resolve, reject) => {
  const el = document.querySelector(${sel});
  if (!el) { reject('__BUNMOT_SELECTOR_NOT_FOUND__:' + ${sel}); return; }
  if (!(el instanceof HTMLElement)) {
    reject('__BUNMOT_NOT_INTERACTABLE__:' + ${sel} + ':not_html_element');
    return;
  }
  el.click();
  resolve({ clicked: true });
});`;
}

export function buildFillScript(selector: string, value: string): string {
  const sel = JSON.stringify(selector);
  const val = JSON.stringify(value);
  return `return new Promise((resolve, reject) => {
  const el = document.querySelector(${sel});
  if (!el) { reject('__BUNMOT_SELECTOR_NOT_FOUND__:' + ${sel}); return; }
  const isInput = el instanceof HTMLInputElement;
  const isTextarea = el instanceof HTMLTextAreaElement;
  if (!isInput && !isTextarea) {
    reject('__BUNMOT_NOT_INTERACTABLE__:' + ${sel} + ':not_input_or_textarea');
    return;
  }
  const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  const setter = desc && desc.set;
  if (typeof setter === 'function') {
    setter.call(el, ${val});
  } else {
    el.value = ${val};
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  resolve({ filled: true });
});`;
}

// §2.3: isVisible は要素なし → { visible: false } で resolve (reject しない)。
// 祖先の opacity は再帰チェックしない (Playwright と同じ簡略化)。
function isVisibleJsExpr(): string {
  // 戻り値: boolean。el は HTMLElement | Element | null。
  return `(function(el){
    if (!el) return false;
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const opacity = parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  })`;
}

export function buildIsVisibleScript(selector: string): string {
  const sel = JSON.stringify(selector);
  return `return new Promise((resolve) => {
  const isVisibleFn = ${isVisibleJsExpr()};
  const el = document.querySelector(${sel});
  resolve({ visible: isVisibleFn(el) });
});`;
}

export function buildGetAttributeScript(selector: string, attribute: string): string {
  const sel = JSON.stringify(selector);
  const attr = JSON.stringify(attribute);
  return `return new Promise((resolve, reject) => {
  const el = document.querySelector(${sel});
  if (!el) { reject('__BUNMOT_SELECTOR_NOT_FOUND__:' + ${sel}); return; }
  const v = el.getAttribute(${attr});
  resolve({ value: v });
});`;
}

export function buildWaitForHiddenScript(
  selector: string,
  chunkTimeoutMs: number,
): string {
  // 「要素がない」「isVisible が false」のいずれかが真なら matched: true。
  // §2.8: 最初から DOM にない場合は即時 matched: true (1 chunk 内で resolve)。
  // characterData / attributes も観察 (style 変化 / class 変化を検知)。
  return buildMutationWaitScript({
    selector,
    chunkTimeoutMs,
    predicateFnBody: `
      const isVisibleFn = ${isVisibleJsExpr()};
      if (!el) return true;
      return !isVisibleFn(el);
    `,
    observeOpts:
      "{ childList: true, subtree: true, attributes: true, characterData: true }",
    withRaf: false,
  });
}

export function buildWaitForTextScript(
  selector: string,
  text: TextMatcher,
  chunkTimeoutMs: number,
): string {
  // text matcher を JS 内で再構築。
  let matcherFnBody: string;
  if (text.kind === "string") {
    const v = JSON.stringify(text.value);
    matcherFnBody = `return (el.textContent || '').includes(${v});`;
  } else {
    const src = JSON.stringify(text.source);
    const flags = JSON.stringify(text.flags);
    matcherFnBody = `return new RegExp(${src}, ${flags}).test(el.textContent || '');`;
  }
  return buildMutationWaitScript({
    selector,
    chunkTimeoutMs,
    // §2.5: selector が DOM になければ chunk timeout まで待機 (false を返して再評価)。
    predicateFnBody: `
      if (!el) return false;
      ${matcherFnBody}
    `,
    observeOpts:
      "{ childList: true, subtree: true, characterData: true, attributes: true }",
    withRaf: false,
  });
}

// §4.2 console patch: WebView 内で window.__BUNMOT_LOGS__ を確立する。
// 二重 inject ガードあり。patch 自身が壊れても元 console は呼ぶ。
export function buildConsolePatchScript(): string {
  return `(function () {
  if (window.__BUNMOT_LOGS__) return;
  const MAX = 1000;
  const buffer = [];
  let dropped = 0;
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  function safeStringify(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { try { return String(v); } catch (e2) { return ''; } }
  }
  function record(level, args) {
    try {
      const message = Array.from(args).map(safeStringify).join(' ');
      buffer.push({ level, message, timestamp: Date.now() });
      if (buffer.length > MAX) {
        buffer.shift();
        dropped++;
      }
    } catch (e) {
      // patch 自体が壊れても元 console は呼び続ける
    }
  }
  console.log = function () { record('log', arguments); return original.log.apply(console, arguments); };
  console.warn = function () { record('warn', arguments); return original.warn.apply(console, arguments); };
  console.error = function () { record('error', arguments); return original.error.apply(console, arguments); };
  window.__BUNMOT_LOGS__ = {
    drain: function () {
      const entries = buffer.slice();
      const droppedCount = dropped;
      buffer.length = 0;
      dropped = 0;
      return { entries: entries, droppedCount: droppedCount };
    }
  };
})();`;
}

// 毎コマンド前に評価する軽量版: 既に inject 済みなら何もしない。
// navigation / reload 後に __BUNMOT_LOGS__ が消えていれば再 inject する。
export function buildEnsurePatchScript(): string {
  return `(function () {
  if (!window.__BUNMOT_LOGS__) {
    ${buildConsolePatchScript()}
  }
})();`;
}

export function buildGetLogsScript(): string {
  return `return new Promise((resolve) => {
  const buf = window.__BUNMOT_LOGS__;
  if (!buf || typeof buf.drain !== 'function') {
    resolve({ entries: [], droppedCount: 0, patchMissing: true });
    return;
  }
  const snap = buf.drain();
  resolve({ entries: snap.entries, droppedCount: snap.droppedCount, patchMissing: false });
});`;
}

// §plan Step 2: html2canvas を inject して toDataURL("image/png") を取る IIFE を生成。
// 冪等性は WebView 側 `window.__bunmot_html2canvas` 存在チェックで担保 (bridge state は増やさない)。
// ポーリングしないこと: setInterval / setTimeout は使わず、html2canvas の Promise を await する。
export function buildScreenshotScript(opts: { fullPage: boolean }): string {
  const target = opts.fullPage ? "document.documentElement" : "document.body";
  // html2canvasSource はライブラリ本体 (UMD)。eval すると window.html2canvas を立ち上げる。
  // ソース内でのシングルクォート / バッククォートは UMD バンドルの構造を壊さないようそのまま埋め込む。
  return `return (async () => {
  if (!window.__bunmot_html2canvas) {
    ${html2canvasSource};
    window.__bunmot_html2canvas = window.html2canvas;
  }
  const canvas = await window.__bunmot_html2canvas(${target}, {
    logging: false,
    useCORS: true,
    allowTaint: false,
    backgroundColor: null,
  });
  const dataUrl = canvas.toDataURL("image/png");
  const PREFIX_LEN = "data:image/png;base64,".length;
  const byteCount = Math.floor((dataUrl.length - PREFIX_LEN) * 3 / 4);
  return { dataUrl: dataUrl, byteCount: byteCount };
})();`;
}
