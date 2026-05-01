# bun-mot — Design

A living document for *why* bun-mot is built the way it is. The README is the canonical source for **what** the API looks like; this file is the canonical source for **why** the architecture is shaped the way it is. Update this file whenever a design decision is made or revised.

> Like an MOT for your van. **bun** = the Bun runtime, also reads as "van"; **MOT** = the UK's annual roadworthiness test. `mot.pass()` prints 🚐✅ when the van clears inspection.

---

## The gap

Electrobun has no built-in E2E driver and the broader ecosystem fills the gap poorly:

| Source | State (2026-04 review) |
|---|---|
| npm / JSR | No general-purpose Electrobun test driver |
| GitHub | No general-purpose framework |
| canter | 12 stars, last touched 2022, not viable |
| agent-electrobun | A CLI specific to the Quiver app, not general-purpose |
| Playwright `connectOverCDP()` | Structurally incompatible with Electrobun's OOPIF model — attach-time navigation breaks Electrobun's RPC registration |

This is a real ecosystem gap. bun-mot exists to fill it as an OSS package.

---

## Architecture

### System diagram

```
Test code (bun:test / Vitest)
  ↕ HTTP POST /command
BunMot client            (bun-mot)
  ↕ HTTP
Bridge server in app     (bun-mot/bridge, injected at app start)
  ↕ view.rpc.request.evaluateJavascriptWithResponse(...)
WKWebView DOM
```

### Why HTTP bridge (not CDP)

Playwright's `connectOverCDP()` is structurally incompatible with Electrobun: attach-time page navigation breaks Electrobun's RPC registration and OOPIF management.

`evaluateJavascriptWithResponse()` already supports Promise-returning scripts, which is enough to express asynchronous DOM observation in-page. Wrapping that in a tiny in-process HTTP server keeps the test runner and the application loosely coupled, and lets bun-mot ride on Electrobun's existing RPC plumbing rather than a foreign protocol.

### Why MutationObserver-based waiting

`waitForSelector` and friends are implemented in-page with **MutationObserver** rather than polling. Polling adds latency proportional to the poll interval and burns CPU; MutationObserver fires synchronously on mutation and can be torn down deterministically when a deadline is reached. `requestAnimationFrame` is allowed only as a fallback for cases where MutationObserver doesn't fire (e.g. attribute changes that don't pass the configured filter).

### Why html2canvas for `screenshot`

The natural choice would have been WKWebView's native `takeSnapshot(with:completionHandler:)`, but Electrobun's public API does not expose it (see [docs/screenshot-strategy.md](screenshot-strategy.md) for the source-dive log). Other candidates considered:

- **macOS `screencapture -l <windowId>`** — pixel-perfect but macOS-only and tied to a private window-id lookup.
- **In-page html2canvas** — fully cross-platform, doesn't require a host-side privilege, accepts a non-trivial fidelity tradeoff (no native chrome, some CSS imperfectly rendered).

Pragmatism wins: html2canvas is injected into the WebView lazily on first capture (~47KB, tens to ~100ms first-call overhead) and the limitations are documented in the README. Pixel-exact visual regression is explicitly out of scope for v0.1.

---

## Command protocol

Requests and responses are typed with a Zod discriminated union (`src/commands.ts`). Every request carries a `type` discriminator plus command-specific fields, and every response is `{ success: true, result }` or `{ success: false, error: { kind, message } }`. Responses are normalized at the bridge so that the client can switch on `error.kind` without parsing free-form text.

```typescript
// Request
POST /command
{
  "type": "waitForSelector",
  "selector": ".mermaid svg",
  "timeout": 5000,
  "viewId": "main"          // optional; reserved for multi-view
}

// In-WebView execution (sketch)
new Promise((resolve, reject) => {
  const observer = new MutationObserver(/* ... */);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // resolve when found, reject on deadline
});

// Response
{ "success": true, "result": { "found": true } }
```

### `viewId` is a v1 placeholder

`viewId` is part of the schema from v0.1.0 onward but the bridge currently routes to a single view, so view switching is a no-op at runtime. Reserving the field upfront avoids a breaking schema change when full multi-view support lands.

### Errors carry a `kind`

| `kind` | Meaning |
|---|---|
| `timeout` | A `waitFor*` deadline expired |
| `selector_not_found` | A read / interact command's selector matched nothing |
| `element_not_interactable` | The matched element wasn't a usable target (e.g. SVG for `click`, non-input for `fill`) |
| `evaluation_error` | The expression in `evaluate` threw |
| `validation_error` | Request didn't parse against the Zod schema |
| `internal_error` | Unhandled bridge / runtime failure |

---

## Design decisions ledger

A running log of the choices that shaped v0.1. Add to this list as new decisions are made.

| Decision | Why | Where it shows up |
|---|---|---|
| HTTP bridge instead of CDP | CDP `connectOverCDP()` is structurally incompatible with Electrobun (OOPIF, RPC registration). | `src/bridge.ts` |
| Zod discriminated union for the wire protocol | Single source of truth for request shapes; bridge & client share it. | `src/commands.ts` |
| MutationObserver-based `waitFor*` | Lower latency than polling; tear-down is deterministic. | `src/scripts.ts` |
| `viewId` reserved from v1 | Prevent a breaking schema change when multi-view ships. | `src/commands.ts`, `src/driver.ts` |
| `mot.view()` uses replace semantics | Chaining `.view('a').view('b')` keeps the *latest* name (intent: rebinding, not nesting). | `src/driver.ts` |
| `screenshot` via html2canvas | `WKWebView.takeSnapshot` is not exposed by Electrobun; html2canvas is cross-platform and good enough for non-pixel-exact assertions. | `src/scripts.ts`, `docs/screenshot-strategy.md` |
| `screenshot(path?, options?)` is positional | Diverges from Playwright's option-bag form on purpose: most callers want `screenshot('path.png')` and a positional first argument keeps the call sites short. | `src/driver.ts` |
| Console logs are consume-on-read with a 1000-entry cap | A drained buffer matches `bun:test` / Vitest expectations (per-test isolation); the cap protects against runaway logging. | `src/scripts.ts` |
| `pass()` always prints, even with `BUN_MOT_LOG=silent` | It's a **user-facing** marker, not a diagnostic. | `src/driver.ts` |
| Bun-only (`engines.bun`, no `engines.node`) | `dist/*.js` are extensionless ESM that Node cannot resolve; `Bun.serve` / `Bun.spawn` are runtime dependencies. | `package.json`, `dist/*` |
| Production exclusion via dynamic import + env-var guard | `bun build --env='BUN_MOT_*'` inlines the env identifier; the guard folds to a constant and the dynamic import is dead-code-eliminated. | `test/integration/prod-build.test.ts` (assertion of build output) |

---

## Roots: line-miniapp-sdk

The HTTP-bridge approach is borrowed from `line-miniapp-sdk` (an internal HTTP-bridge-based remote E2E driver Claude Code worked on previously). The mapping:

```
line-miniapp-sdk             →   bun-mot
─────────────────────────────────────────────────────
Cloud Run backend            →   In-app Bun HTTP server
HTTP POST /commands          →   POST /command (Bun built-in HTTP server)
Browser / WebView            →   WKWebView
evaluateJavaScript           →   evaluateJavascriptWithResponse()
OIDC auth                    →   None (loopback only)
Session management           →   Per app lifecycle (simplified)
```

bun-mot drops the cloud and auth layers; everything is local-loopback only. The bridge listens on `127.0.0.1` and never on a public interface.

---

## Roadmap

### Shipped in v0.1

- [x] HTTP bridge server (app side)
- [x] Client API (`waitForSelector` / `getText` / `evaluate` / `click` / `fill` / `waitForHidden` / `waitForText` / `isVisible` / `getAttribute`)
- [x] `screenshot` (html2canvas-based)
- [x] `getLogs` (console capture with FIFO cap and consume-on-read)
- [x] `launch()` test helper (bun:test / Vitest agnostic)
- [x] `mot.view()` placeholder API for forward-compat
- [x] Production build exclusion (env-var guard) with measured DCE in CI
- [x] npm publish (Manual Token for v0.1.0; OIDC Trusted Publishing wired up via `.github/workflows/release.yml` for v0.1.1+)

### Considered for v0.2+

- Real multi-view routing in the bridge so `mot.view(name)` actually targets different BrowserViews.
- Pixel-exact `screenshot` (revisit `takeSnapshot` if Electrobun exposes it; otherwise consider macOS `screencapture -l` for visual regression workflows).
- Native focus/click semantics in `click` (actionability checks, hit-testing).
- Optional Node runtime support — depends on emitting `.js` extensions and ditching the Bun-only globals (`Bun.serve`, `Bun.spawn`); there is a dormant `eval("require")` fallback in `src/launch.ts` placeholding for this.

This roadmap is a sketch, not a commitment. Open an issue to discuss scope before implementing.

---

## References

- README — canonical API surface (English: [`README.md`](../README.md), 日本語: [`docs/README.ja.md`](README.ja.md))
- [`docs/screenshot-strategy.md`](screenshot-strategy.md) — investigation log for the screenshot decision
- Origin architecture: `line-miniapp-sdk` (HTTP bridge + Zod schema + WebView evaluation)
