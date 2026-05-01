import { describe, expect, test } from "bun:test";
import {
  buildEvaluateScript,
  buildWaitForSelectorScript,
  buildGetTextScript,
  buildClickScript,
  buildFillScript,
  buildIsVisibleScript,
  buildGetAttributeScript,
  buildWaitForHiddenScript,
  buildWaitForTextScript,
  buildConsolePatchScript,
  buildEnsurePatchScript,
  buildGetLogsScript,
  buildScreenshotScript,
} from "../src/scripts";

describe("buildEvaluateScript", () => {
  // Electrobun 1.16 builtin RPC は `new Function(script)()` で実行する。
  // body に return が無いと結果が常に undefined になるため、`return (expr);` で wrap する。
  test("式を `return (expr);` で wrap する", () => {
    expect(buildEvaluateScript("1 + 1")).toBe("return (1 + 1);");
    expect(buildEvaluateScript("document.title")).toBe("return (document.title);");
  });

  test("new Function(script)() で評価すると値が返る", () => {
    expect(new Function(buildEvaluateScript("1 + 1"))()).toBe(2);
    expect(new Function(buildEvaluateScript("'a' + 'b'"))()).toBe("ab");
  });
});

describe("scripts: new Function(script)() で実行可能 (Electrobun 1.16 互換性)", () => {
  // issue #1 回帰防止: bridge は scripts.ts の戻り値を Electrobun の builtin handler に
  // そのまま渡し、handler 側で `new Function(script)()` 経由で実行される。
  // 各 builder は最低限「Promise を返す」もしくは「同期的に値を返す」必要がある。
  test("buildWaitForSelectorScript は Promise を返す", () => {
    const result = new Function(buildWaitForSelectorScript(".never", 0))();
    expect(result).toBeInstanceOf(Promise);
    // 0ms timeout なので reject されるはずだが、ここでは ID として捨てる
    void (result as Promise<unknown>).catch(() => {});
  });

  test("buildGetTextScript は Promise を返す", () => {
    const result = new Function(buildGetTextScript("h1"))();
    expect(result).toBeInstanceOf(Promise);
    void (result as Promise<unknown>).catch(() => {});
  });

  test("buildClickScript は Promise を返す", () => {
    const result = new Function(buildClickScript(".btn"))();
    expect(result).toBeInstanceOf(Promise);
    void (result as Promise<unknown>).catch(() => {});
  });

  test("buildFillScript は Promise を返す", () => {
    const result = new Function(buildFillScript(".x", "v"))();
    expect(result).toBeInstanceOf(Promise);
    void (result as Promise<unknown>).catch(() => {});
  });

  test("buildIsVisibleScript は Promise を返す", () => {
    const result = new Function(buildIsVisibleScript(".x"))();
    expect(result).toBeInstanceOf(Promise);
    void (result as Promise<unknown>).catch(() => {});
  });

  test("buildGetAttributeScript は Promise を返す", () => {
    const result = new Function(buildGetAttributeScript(".x", "data-id"))();
    expect(result).toBeInstanceOf(Promise);
    void (result as Promise<unknown>).catch(() => {});
  });

  test("buildWaitForHiddenScript は Promise を返す", () => {
    const result = new Function(buildWaitForHiddenScript(".x", 0))();
    expect(result).toBeInstanceOf(Promise);
    void (result as Promise<unknown>).catch(() => {});
  });

  test("buildWaitForTextScript は Promise を返す", () => {
    const result = new Function(
      buildWaitForTextScript(".x", { kind: "string", value: "v" }, 0),
    )();
    expect(result).toBeInstanceOf(Promise);
    void (result as Promise<unknown>).catch(() => {});
  });

  test("buildGetLogsScript は Promise を返す", () => {
    const result = new Function(buildGetLogsScript())();
    expect(result).toBeInstanceOf(Promise);
    void (result as Promise<unknown>).catch(() => {});
  });

  test("buildScreenshotScript は Promise を返す", () => {
    // html2canvas が無い環境では reject されるが、ここでは return 値が Promise であることだけ確認
    const result = new Function(buildScreenshotScript({ fullPage: true }))();
    expect(result).toBeInstanceOf(Promise);
    void (result as Promise<unknown>).catch(() => {});
  });
});

describe("buildWaitForSelectorScript", () => {
  test("MutationObserver を使っている", () => {
    const script = buildWaitForSelectorScript(".foo", 5000);
    expect(script).toContain("MutationObserver");
  });

  test("ポーリングパターン (setInterval / setTimeout(check) ループ) が含まれない", () => {
    const script = buildWaitForSelectorScript(".foo", 5000);
    expect(script).not.toMatch(/setInterval/);
    // setTimeout は timeout reject にしか使わない (ループ不可)
    const setTimeoutCount = (script.match(/setTimeout\(/g) ?? []).length;
    expect(setTimeoutCount).toBeLessThanOrEqual(1);
  });

  test("requestAnimationFrame フォールバックが 1 回だけ含まれる", () => {
    const script = buildWaitForSelectorScript(".foo", 5000);
    const rafCount = (script.match(/requestAnimationFrame/g) ?? []).length;
    expect(rafCount).toBe(1);
  });

  test("セレクターが JSON.stringify でエスケープされる", () => {
    const script = buildWaitForSelectorScript('.foo[data-name="x"]', 5000);
    // ダブルクォートは \" にエスケープされている
    expect(script).toContain('".foo[data-name=\\"x\\"]"');
  });

  test("シングルクォートを含むセレクターでも script が構文エラーにならない", () => {
    const script = buildWaitForSelectorScript("[name='x']", 5000);
    // new Function でパースできる = 構文 OK
    expect(() => new Function(script)).not.toThrow();
  });

  test("ダブルクォートを含むセレクターでも script が構文エラーにならない", () => {
    const script = buildWaitForSelectorScript('[name="x"]', 5000);
    expect(() => new Function(script)).not.toThrow();
  });

  test("timeout 値が script に埋め込まれる", () => {
    const script = buildWaitForSelectorScript(".foo", 1234);
    expect(script).toContain("1234");
  });

  test("timeout reject は __BUNMOT_TIMEOUT__ prefix で reject する", () => {
    const script = buildWaitForSelectorScript(".foo", 5000);
    expect(script).toContain("__BUNMOT_TIMEOUT__");
  });

  test("found: true で resolve する", () => {
    const script = buildWaitForSelectorScript(".foo", 5000);
    expect(script).toContain("found");
    expect(script).toContain("true");
  });
});

describe("buildGetTextScript", () => {
  test("セレクターが JSON.stringify でエスケープされる", () => {
    const script = buildGetTextScript('h1[data-x="y"]');
    expect(script).toContain('"h1[data-x=\\"y\\"]"');
  });

  test("見つからない場合は __BUNMOT_SELECTOR_NOT_FOUND__ prefix で reject する", () => {
    const script = buildGetTextScript("h1");
    expect(script).toContain("__BUNMOT_SELECTOR_NOT_FOUND__");
  });

  test("text フィールドを含む object で resolve する", () => {
    const script = buildGetTextScript("h1");
    expect(script).toContain("text");
    expect(script).toContain("textContent");
  });

  test("script が構文エラーにならない", () => {
    expect(() => new Function(buildGetTextScript("h1"))).not.toThrow();
    expect(() => new Function(buildGetTextScript("[name='x']"))).not.toThrow();
    expect(() => new Function(buildGetTextScript('[name="x"]'))).not.toThrow();
  });
});

describe("buildClickScript", () => {
  test("セレクターが JSON.stringify でエスケープされる", () => {
    const script = buildClickScript('.btn[data-id="1"]');
    expect(script).toContain('".btn[data-id=\\"1\\"]"');
  });

  test("見つからない場合は __BUNMOT_SELECTOR_NOT_FOUND__ prefix で reject する", () => {
    const script = buildClickScript(".btn");
    expect(script).toContain("__BUNMOT_SELECTOR_NOT_FOUND__");
  });

  test("HTMLElement でなければ __BUNMOT_NOT_INTERACTABLE__ prefix で reject する", () => {
    const script = buildClickScript(".btn");
    expect(script).toContain("__BUNMOT_NOT_INTERACTABLE__");
  });

  test("el.click() を呼ぶ", () => {
    const script = buildClickScript(".btn");
    expect(script).toContain(".click()");
  });

  test("clicked: true で resolve する", () => {
    const script = buildClickScript(".btn");
    expect(script).toContain("clicked");
    expect(script).toContain("true");
  });

  test("script が構文エラーにならない", () => {
    expect(() => new Function(buildClickScript(".btn"))).not.toThrow();
    expect(() => new Function(buildClickScript('[data-x="y"]'))).not.toThrow();
  });
});

describe("buildFillScript", () => {
  test("セレクターと値が JSON.stringify でエスケープされる", () => {
    const script = buildFillScript(".input", 'hello "world"');
    expect(script).toContain('".input"');
    expect(script).toContain('"hello \\"world\\""');
  });

  test("native setter pattern を使う (React 互換)", () => {
    const script = buildFillScript(".input", "hi");
    expect(script).toContain("Object.getOwnPropertyDescriptor");
    expect(script).toContain("HTMLInputElement.prototype");
    expect(script).toContain("HTMLTextAreaElement.prototype");
  });

  test("input / change イベントを dispatch する", () => {
    const script = buildFillScript(".input", "hi");
    expect(script).toContain("'input'");
    expect(script).toContain("'change'");
    expect(script).toContain("dispatchEvent");
  });

  test("見つからない場合は __BUNMOT_SELECTOR_NOT_FOUND__ で reject", () => {
    const script = buildFillScript(".input", "hi");
    expect(script).toContain("__BUNMOT_SELECTOR_NOT_FOUND__");
  });

  test("input / textarea でない場合は __BUNMOT_NOT_INTERACTABLE__ で reject", () => {
    const script = buildFillScript(".x", "v");
    expect(script).toContain("__BUNMOT_NOT_INTERACTABLE__");
  });

  test("filled: true で resolve する", () => {
    const script = buildFillScript(".input", "hi");
    expect(script).toContain("filled");
  });

  test("script が構文エラーにならない", () => {
    expect(() => new Function(buildFillScript(".x", "v"))).not.toThrow();
    expect(() => new Function(buildFillScript(".x", 'a"b'))).not.toThrow();
  });
});

describe("buildIsVisibleScript", () => {
  test("getComputedStyle と getBoundingClientRect の判定式を含む", () => {
    const script = buildIsVisibleScript(".x");
    expect(script).toContain("getComputedStyle");
    expect(script).toContain("getBoundingClientRect");
  });

  test("display / visibility / opacity をチェックする", () => {
    const script = buildIsVisibleScript(".x");
    expect(script).toContain("display");
    expect(script).toContain("visibility");
    expect(script).toContain("opacity");
  });

  test("要素なしの場合は { visible: false } で resolve する (reject しない)", () => {
    const script = buildIsVisibleScript(".x");
    // null でも reject ではなく resolve { visible: false } する
    expect(script).toContain("visible");
    expect(script).toContain("false");
    expect(script).not.toContain("__BUNMOT_SELECTOR_NOT_FOUND__");
  });

  test("script が構文エラーにならない", () => {
    expect(() => new Function(buildIsVisibleScript(".x"))).not.toThrow();
  });
});

describe("buildGetAttributeScript", () => {
  test("セレクターと属性が JSON.stringify でエスケープされる", () => {
    const script = buildGetAttributeScript(".x", "data-id");
    expect(script).toContain('".x"');
    expect(script).toContain('"data-id"');
  });

  test("見つからない場合は __BUNMOT_SELECTOR_NOT_FOUND__ で reject", () => {
    const script = buildGetAttributeScript(".x", "data-id");
    expect(script).toContain("__BUNMOT_SELECTOR_NOT_FOUND__");
  });

  test("getAttribute の結果を value フィールドで返す", () => {
    const script = buildGetAttributeScript(".x", "data-id");
    expect(script).toContain("getAttribute");
    expect(script).toContain("value");
  });

  test("script が構文エラーにならない", () => {
    expect(() => new Function(buildGetAttributeScript(".x", "data-id"))).not.toThrow();
  });
});

describe("buildWaitForHiddenScript", () => {
  test("MutationObserver を使う", () => {
    const script = buildWaitForHiddenScript(".x", 1000);
    expect(script).toContain("MutationObserver");
  });

  test("__BUNMOT_TIMEOUT__ prefix で timeout reject", () => {
    const script = buildWaitForHiddenScript(".x", 1000);
    expect(script).toContain("__BUNMOT_TIMEOUT__");
  });

  test("hidden: true で resolve する", () => {
    const script = buildWaitForHiddenScript(".x", 1000);
    expect(script).toContain("hidden");
    expect(script).toContain("true");
  });

  test("display / visibility / opacity / rect の判定を含む (isVisible 否定)", () => {
    const script = buildWaitForHiddenScript(".x", 1000);
    expect(script).toContain("getComputedStyle");
    expect(script).toContain("getBoundingClientRect");
  });

  test("timeout 値が script に埋め込まれる", () => {
    expect(buildWaitForHiddenScript(".x", 4321)).toContain("4321");
  });

  test("script が構文エラーにならない", () => {
    expect(() => new Function(buildWaitForHiddenScript(".x", 1000))).not.toThrow();
  });
});

describe("buildWaitForTextScript", () => {
  test("string matcher で textContent.includes を使う", () => {
    const script = buildWaitForTextScript(
      ".x",
      { kind: "string", value: "hi" },
      1000,
    );
    expect(script).toContain("includes");
    expect(script).toContain('"hi"');
  });

  test("regex matcher で new RegExp と test を使う", () => {
    const script = buildWaitForTextScript(
      ".x",
      { kind: "regex", source: "h.+", flags: "i" },
      1000,
    );
    expect(script).toContain("RegExp");
    expect(script).toContain('"h.+"');
    expect(script).toContain('"i"');
    expect(script).toContain(".test(");
  });

  test("MutationObserver で textNode の変更を監視する (characterData)", () => {
    const script = buildWaitForTextScript(
      ".x",
      { kind: "string", value: "hi" },
      1000,
    );
    expect(script).toContain("MutationObserver");
    expect(script).toContain("characterData");
  });

  test("matched: true で resolve する", () => {
    const script = buildWaitForTextScript(
      ".x",
      { kind: "string", value: "hi" },
      1000,
    );
    expect(script).toContain("matched");
  });

  test("__BUNMOT_TIMEOUT__ prefix で timeout reject", () => {
    const script = buildWaitForTextScript(
      ".x",
      { kind: "string", value: "hi" },
      1000,
    );
    expect(script).toContain("__BUNMOT_TIMEOUT__");
  });

  test("script が構文エラーにならない", () => {
    expect(() =>
      new Function(buildWaitForTextScript(".x", { kind: "string", value: "v" }, 1000)),
    ).not.toThrow();
    expect(() =>
      new Function(
        buildWaitForTextScript(".x", { kind: "regex", source: "h.+", flags: "i" }, 1000),
      ),
    ).not.toThrow();
  });
});

describe("buildConsolePatchScript / buildEnsurePatchScript", () => {
  test("console patch は二重 inject ガードを含む (return early)", () => {
    const script = buildConsolePatchScript();
    expect(script).toContain("__BUNMOT_LOGS__");
    // 既に存在する場合は早期 return
    expect(script).toMatch(/window\.__BUNMOT_LOGS__/);
  });

  test("MAX (1000) と FIFO drop ロジックを含む", () => {
    const script = buildConsolePatchScript();
    expect(script).toContain("1000");
    expect(script).toContain("shift");
  });

  test("console.log / warn / error をパッチする", () => {
    const script = buildConsolePatchScript();
    expect(script).toContain("console.log");
    expect(script).toContain("console.warn");
    expect(script).toContain("console.error");
  });

  test("drain() メソッドを公開する", () => {
    const script = buildConsolePatchScript();
    expect(script).toContain("drain");
  });

  test("ensure script は !window.__BUNMOT_LOGS__ ガードを持つ", () => {
    const script = buildEnsurePatchScript();
    expect(script).toContain("!window.__BUNMOT_LOGS__");
  });

  test("script が構文エラーにならない", () => {
    expect(() => new Function(buildConsolePatchScript())).not.toThrow();
    expect(() => new Function(buildEnsurePatchScript())).not.toThrow();
  });
});

describe("buildGetLogsScript", () => {
  test("__BUNMOT_LOGS__ 未定義時は patchMissing: true を resolve", () => {
    const script = buildGetLogsScript();
    expect(script).toContain("patchMissing");
    expect(script).toContain("true");
  });

  test("drain() を呼んで entries / droppedCount を返す", () => {
    const script = buildGetLogsScript();
    expect(script).toContain("drain");
    expect(script).toContain("entries");
    expect(script).toContain("droppedCount");
  });

  test("script が構文エラーにならない", () => {
    expect(() => new Function(buildGetLogsScript())).not.toThrow();
  });
});

describe("buildScreenshotScript", () => {
  test("fullPage: true で document.documentElement を target にする", () => {
    const script = buildScreenshotScript({ fullPage: true });
    expect(script).toContain("document.documentElement");
  });

  test("fullPage: false で document.body を target にする", () => {
    const script = buildScreenshotScript({ fullPage: false });
    expect(script).toContain("document.body");
  });

  test("html2canvas の inject ガード (__bunmot_html2canvas) を含む", () => {
    const script = buildScreenshotScript({ fullPage: true });
    expect(script).toContain("__bunmot_html2canvas");
  });

  test("toDataURL('image/png') を呼ぶ", () => {
    const script = buildScreenshotScript({ fullPage: true });
    expect(script).toContain('toDataURL("image/png")');
  });

  test("dataUrl と byteCount を含む object を resolve する", () => {
    const script = buildScreenshotScript({ fullPage: true });
    expect(script).toContain("dataUrl");
    expect(script).toContain("byteCount");
  });

  test("async IIFE 形式 (Promise を返す式)", () => {
    const script = buildScreenshotScript({ fullPage: true });
    expect(script).toContain("async");
  });

  test("wrapper 部分にポーリング (setInterval / setTimeout) を含まない", () => {
    // 注: html2canvas 本体は内部で setTimeout を使うため除外して wrapper だけ確認する。
    // bun-mot 側のコードはポーリング禁止 (CLAUDE.md)、await Promise でのみ完結することを保証。
    const script = buildScreenshotScript({ fullPage: true });
    const marker = "window.__bunmot_html2canvas = window.html2canvas;";
    const wrapperStart = script.indexOf(marker);
    expect(wrapperStart).toBeGreaterThan(0);
    const wrapper = script.slice(wrapperStart);
    expect(wrapper).not.toMatch(/setInterval/);
    expect(wrapper).not.toMatch(/setTimeout/);
  });

  test("html2canvas オプション (logging:false, useCORS:true) を含む", () => {
    const script = buildScreenshotScript({ fullPage: true });
    expect(script).toContain("logging");
    expect(script).toContain("useCORS");
  });

  test("html2canvas のソースが埋め込まれている (47KB 級の大文字列)", () => {
    const script = buildScreenshotScript({ fullPage: true });
    // bundle 自体は大きい (10KB 以上を保守的に確認)
    expect(script.length).toBeGreaterThan(10_000);
  });
});
