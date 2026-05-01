// Bun の `with { type: "text" }` import で html2canvas のソースを文字列として取り込むための型宣言。
// この .d.ts は Step 0 (text import probe) で第一候補 (a) を採用した結果として作成された。
declare module "html2canvas/dist/html2canvas.min.js" {
  const source: string;
  export default source;
}
