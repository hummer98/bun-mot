// CLAUDE.md ロギングポリシーに準拠した log 関数。
// フォーマット: `[ISO8601] event_name key1=value1 key2=value2`
// フィールドキーは camelCase 統一 (呼び出し側の責務)。

// tsconfig.build.json の `types: []` で @types/bun が外れたため、
// 公開 .d.ts に Node/Bun 型を漏出させずに `process.env` を使うため inline 宣言する。
// runtime では Bun が `process` を提供する (Node 互換)。
declare const process: { env: Record<string, string | undefined> };

type LogValue = string | number | boolean | null | undefined;

export function log(event: string, fields: Record<string, LogValue> = {}): void {
  if (process.env["BUN_MOT_LOG"] === "silent") return;
  const ts = new Date().toISOString();
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(" ");
  console.log(`[${ts}] ${event}${parts ? " " + parts : ""}`);
}

function formatValue(v: LogValue): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    // 空白 / `=` / `"` を含む場合は JSON.stringify でクォート
    if (/[\s="]/.test(v)) return JSON.stringify(v);
    return v;
  }
  return String(v);
}
