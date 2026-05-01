import { describe, expect, test } from "bun:test";
import html2canvasSource from "html2canvas/dist/html2canvas.min.js" with { type: "text" };

// Step 0: Bun の attribute import (`with { type: "text" }`) が機能していることを確認する probe。
// もしこのテストが落ちる場合は plan §4.2 のフォールバック (b) `fs.readFileSync(require.resolve(...))`
// に切り替える。
describe("html2canvas text import (Step 0 probe)", () => {
  test("空でない文字列として読み込める", () => {
    expect(typeof html2canvasSource).toBe("string");
    expect(html2canvasSource.length).toBeGreaterThan(1000);
  });

  test("html2canvas 識別子を含む (バンドル本体であることの確認)", () => {
    expect(html2canvasSource).toContain("html2canvas");
  });
});
