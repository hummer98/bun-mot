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
} from "../src/scripts";

describe("buildEvaluateScript", () => {
  test("式をそのまま返す (透過)", () => {
    expect(buildEvaluateScript("1 + 1")).toBe("1 + 1");
    expect(buildEvaluateScript("document.title")).toBe("document.title");
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
