// WebView (Electrobun) に注入する JS 文字列のビルダー。
// すべて Promise を返す式として組み立て、evaluateJavascriptWithResponse 経由で resolve/reject させる。
// reject 文字列は prefix で kind を識別 (§4.4)。

export function buildEvaluateScript(expression: string): string {
  // 任意式をそのまま渡す。値は evaluateJavascriptWithResponse が JSON シリアライズして返す。
  return expression;
}

export function buildWaitForSelectorScript(selector: string, timeout: number): string {
  // MutationObserver で DOM 変化を監視。ポーリング不可 (CLAUDE.md)。
  // rAF フォールバック 1 回のみ許容。
  const sel = JSON.stringify(selector);
  const t = String(timeout);
  return `new Promise((resolve, reject) => {
  const SELECTOR = ${sel};
  const TIMEOUT = ${t};
  const start = Date.now();

  const initial = document.querySelector(SELECTOR);
  if (initial) { resolve({ found: true }); return; }

  let timeoutId;
  const done = () => {
    observer.disconnect();
    clearTimeout(timeoutId);
    resolve({ found: true });
  };
  const observer = new MutationObserver(() => {
    if (document.querySelector(SELECTOR)) done();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // rAF フォールバック: 初回描画直後に 1 回だけ追加チェック
  requestAnimationFrame(() => {
    if (document.querySelector(SELECTOR)) done();
  });

  timeoutId = setTimeout(() => {
    observer.disconnect();
    reject('__BUNMOT_TIMEOUT__:' + SELECTOR + ':' + (Date.now() - start));
  }, TIMEOUT);
});`;
}

export function buildGetTextScript(selector: string): string {
  const sel = JSON.stringify(selector);
  return `new Promise((resolve, reject) => {
  const el = document.querySelector(${sel});
  if (!el) { reject('__BUNMOT_SELECTOR_NOT_FOUND__:' + ${sel}); return; }
  resolve({ text: el.textContent ?? '' });
});`;
}
