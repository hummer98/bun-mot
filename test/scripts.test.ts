import { describe, expect, test } from "bun:test";
import {
  buildEvaluateScript,
  buildWaitForSelectorScript,
  buildGetTextScript,
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
