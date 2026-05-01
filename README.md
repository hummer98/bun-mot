# bun-mot

**English** | [日本語](docs/README.ja.md)

E2E testing driver for [Electrobun](https://electrobun.dev/) apps. Like an MOT for your van. 🚐✅

```typescript
import { BunMot } from "bun-mot";

const mot = new BunMot({ port: 4747 });
await mot.waitForSelector(".mermaid svg");
const heading = await mot.getText("h1");
```

## Why bun-mot

Electrobun ships with no built-in E2E driver, and the broader ecosystem has nothing general-purpose to fill the gap — search npm, JSR, or GitHub for "Electrobun" plus "test" and you come up empty. Playwright's `connectOverCDP()` doesn't help either: Electrobun's WKWebView lives in an out-of-process iframe model that breaks Playwright's attach-time navigation and clobbers Electrobun's own RPC registration. The closest community efforts (canter, agent-electrobun) are stale or app-specific.

bun-mot fills that hole with a small, borrowed idea: instead of speaking CDP, it ships a tiny HTTP server *into the app under test* and routes commands to the WKWebView through `view.rpc.request.evaluateJavascriptWithResponse(...)`. The test process POSTs typed commands, the bridge evaluates them in the WebView, and results come back as JSON. Test code and application stay loosely coupled, and bun-mot rides on Electrobun's own RPC plumbing rather than a foreign protocol.

The API surface follows Playwright on purpose — `waitForSelector`, `getText`, `click`, `fill`, `screenshot` mean what you expect — so there is nothing new to learn. The name is a small joke: **bun** is the Bun runtime, but it also reads as "van"; **MOT** is the UK's annual roadworthiness test. `mot.pass()` prints 🚐✅ when your van passes its inspection. Deeper design notes live in [docs/design.md](docs/design.md).

## Install

```bash
bun add bun-mot
```

## Usage

bun-mot has two halves: an **app-side bridge** (HTTP server inside the Electrobun app) and a **test-side client** (`BunMot`).

### 1. App side: start the bridge

Wire `setupBunMot` into your Electrobun entry point with a **dynamic import + env-var guard**. This keeps `bun-mot/bridge` out of the production bundle (see [Production build exclusion](#production-build-exclusion)).

```typescript
// app/main.ts
import { BrowserWindow } from "electrobun/bun";

const win = new BrowserWindow({
  url: "views://my-app/index.html",
});

// Dynamic import + env-var guard:
//   (1) only import the bridge when BUN_MOT_PORT is set
//   (2) Bun's `--env='BUN_MOT_*'` inlines `process.env.BUN_MOT_PORT` at build time;
//       in production the guard folds to a constant false and the dead branch is removed.
if (process.env.BUN_MOT_PORT) {
  const { setupBunMot } = await import("bun-mot/bridge");
  const port = Number(process.env.BUN_MOT_PORT);
  const mot = setupBunMot(win.webview, { port });
  // The marker line that launch() reads from stdout (avoids a TOCTOU race on the port).
  console.log(`fixture-bridge-ready port=${mot.port}`);
  process.on("SIGTERM", () => mot.stop());
}
```

> **Note**: use **identifier access** (`process.env.BUN_MOT_PORT`), not bracket access (`process.env["BUN_MOT_PORT"]`). Bun's `--env='BUN_MOT_*'` build-time inlining only matches identifier form.

The `view` argument is anything that satisfies this shape. Electrobun's `BrowserView` / `webview` already does (the signature matches Electrobun 1.16's builtin RPC).

```typescript
interface BunMotView {
  rpc: {
    request: {
      evaluateJavascriptWithResponse(params: { script: string }): Promise<unknown>;
    };
  };
}
```

### 1.5. App side: initialize `Electroview` in mainview

bun-mot drives the WebView through Electrobun's RPC transport. The transport's request handler (`evaluateJavascriptWithResponse`) is registered by the **`Electroview` constructor on the browser side** — without it, every command from bun-mot times out before it ever reaches your DOM.

If your mainview only uses `__electrobunSendToHost()` style messaging (no bun → browser RPC), you have probably never instantiated `Electroview`. Add it now:

```typescript
// app/views/mainview/index.ts
import { Electroview } from "electrobun/view";

new Electroview({
  rpc: Electroview.defineRPC({ handlers: { requests: {}, messages: {} } }),
});
```

If you already define your own request / message handlers, pass them through the same `defineRPC` call.

Symptom you will see if this is missing (from the bridge log):

```
[bridge_started] port=4747 hostname=127.0.0.1
[command_received] type=evaluate expression=1+1
[console_patch_failed] phase=bootstrap message="RPC request timed out."
[command_completed] type=evaluate success=false durationMs=1002 kind=evaluation_error
```

### 2. Test side: drive it with `BunMot`

```typescript
import { BunMot } from "bun-mot";

const mot = new BunMot({ port: 4747 });

// Wait for a selector (MutationObserver-based, default 5000ms)
await mot.waitForSelector(".mermaid svg");

// Read text
const heading = await mot.getText("h1");

// Evaluate any expression
const title = await mot.evaluate("document.title");

// Screenshot to file
await mot.screenshot("./screenshots/result.png");

// Or omit the path and pipe the Buffer somewhere
const { buffer, byteCount } = await mot.screenshot();
console.log(`captured ${byteCount} bytes`);

// Body-only capture
await mot.screenshot("./body-only.png", { fullPage: false });

// User-facing pass() — print 🚐✅ when all assertions are green
await mot.pass("Mermaid renders");
// → 🚐✅ bun-mot: all assertions passed (Mermaid renders)
```

### 3. Test side: spawn the app with `launch()`

`bun-mot/launch` does **spawn → wait for bridge → build a `BunMot`** in one call. It is test-runner-agnostic and works under both `bun:test` and Vitest.

```typescript
// bun:test
import { test, expect } from "bun:test";
import { launch } from "bun-mot/launch";

test("home heading renders", async () => {
  const { app, mot } = await launch({
    appPath: "./apps/my-app/main.ts",
    readyTimeout: 10_000,
  });
  try {
    await mot.waitForSelector("h1");
    expect(await mot.getText("h1")).toBe("Hello");
    await mot.pass();
  } finally {
    await app.close();
  }
});
```

```typescript
// Vitest (install vitest in your project separately)
import { test, expect } from "vitest";
import { launch } from "bun-mot/launch";

test("home heading renders", async () => {
  const { app, mot } = await launch({ appPath: "./apps/my-app/main.ts" });
  try {
    await mot.waitForSelector("h1");
    expect(await mot.getText("h1")).toBe("Hello");
  } finally {
    await app.close();
  }
});
```

What `launch()` does, in order:

1. Spawns the child with `BUN_MOT_PORT` in env (default `0` so the child picks a free port).
2. Reads a `fixture-bridge-ready port=NNNN` marker line from the child's stdout to learn the actual port (avoids the TOCTOU window of `net.createServer(0)`).
3. Confirms TCP connectivity to that port, then constructs `BunMot` and returns it.
4. `app.close()` issues SIGTERM, falls back to SIGKILL after 1.5s. Idempotent.

If `readyTimeout` expires the rejection includes elapsed ms, the last connection target, and the tail of the child's stdout/stderr.

### 4. Multiple views and the `view()` v1 limitation

An Electrobun app can host multiple BrowserViews (each with its own HTML/DOM). `mot.view(name)` is shipped from v1 with the API surface in place, and the request body always carries `viewId`.

```typescript
const main = mot.view("main");
await main.waitForSelector(".mermaid svg");
const heading = await main.getText("h1");
```

`view()` chains use **replace semantics** (last name wins):

```typescript
mot.view("a").view("b").evaluate("1");
// viewId sent on the wire is "b"
```

**v1 limitation**: the bridge currently routes to a single view, so view switching has no runtime effect yet. End-to-end multi-view support is on the post-v1 roadmap. The `view()` API is a forward-compatible placeholder.

### Environment variables

| Variable | Purpose |
|---|---|
| `BUN_MOT_PORT` | Port the bridge binds to (read by the app side). |
| `BUN_MOT_LOG=silent` | Suppress bun-mot's own logging (handy in tests). |

## API

### `setupBunMot(view, options)`

Starts the in-app HTTP bridge.

| Argument | Type | Required | Description |
|---|---|---|---|
| `view` | `BunMotView` | ✓ | Object exposing `evaluateJavascriptWithResponse`. |
| `options.port` | `number` | ✓ | Bind port (`0` for an ephemeral one). |
| `options.hostname` | `string` |  | Bind host (default `127.0.0.1`). |
| `options.bootstrapTimeoutMs` | `number` |  | Timeout for the first `console.*` patch injection (ms, default `5000`). |

Returns: `{ port: number, stop(): void }`.

### `new BunMot(options)`

The test-side client.

| Argument | Type | Required | Description |
|---|---|---|---|
| `options.port` | `number` | ✓ | Bridge port. |
| `options.hostname` | `string` |  | Bridge host (default `127.0.0.1`). |
| `options.defaultTimeout` | `number` |  | Default timeout (ms) for `waitForSelector` etc. (default `5000`). |
| `options.viewId` | `string` |  | Reserved for multi-view support. When set, every request carries this `viewId` (the bridge ignores it in v1). |

#### Methods

| Method | Description | Returns |
|---|---|---|
| `evaluate(expression)` | Evaluate any expression in the WebView | `Promise<unknown>` |
| `waitForSelector(selector, options?)` | Wait for a selector (MutationObserver) | `Promise<void>` |
| `getText(selector)` | Read `textContent` | `Promise<string>` |
| `click(selector)` | Call `el.click()` on the matched element | `Promise<void>` |
| `fill(selector, value)` | Set `<input>` / `<textarea>` value (native setter + `input` / `change` events) | `Promise<void>` |
| `waitForHidden(selector, options?)` | Wait until the element is hidden / detached | `Promise<void>` |
| `waitForText(selector, text, options?)` | Wait until `text` (string or RegExp) appears in `textContent` | `Promise<void>` |
| `isVisible(selector)` | Visibility check (display / visibility / opacity / 0×0 rect) | `Promise<boolean>` |
| `getAttribute(selector, attribute)` | Read an attribute, `null` if absent | `Promise<string \| null>` |
| `getLogs()` | Drain the buffered console log entries | `Promise<ConsoleLogEntry[]>` |
| `screenshot(path?, options?)` | Capture the WebView DOM as PNG. With `path` writes to disk; without it returns a Buffer. | `Promise<{ path, byteCount } \| { buffer, byteCount }>` |
| `view(name)` | Return a handle scoped to a named view (see v1 limitation above) | `BunMotScopedView` |
| `pass(message?)` | 🚐✅ user-facing pass marker. Returns `Promise<void>`, so `await` it. Always prints, even with `BUN_MOT_LOG=silent`. | `Promise<void>` |

`waitFor*` methods fall back to `defaultTimeout` (5000ms) when `options.timeout` is omitted.

`screenshot` options:

| Key | Type | Default | Description |
|---|---|---|---|
| `fullPage` | `boolean` | `true` | `true` targets `document.documentElement`; `false` targets `document.body`. |

> Difference from Playwright: `screenshot(path?, options?)` takes `path` as a **positional first argument** (Playwright uses an option-bag `screenshot({ path, ... })`).

`BunMotScopedView` exposes the same command methods as `BunMot` (`evaluate` / `waitForSelector` / `getText` / `click` / `fill` / `waitForHidden` / `waitForText` / `isVisible` / `getAttribute` / `getLogs` / `view`). Chained `view()` uses **replace semantics** — `mot.view('a').view('b')` sends `viewId: 'b'`. `screenshot` is not exposed on scoped views in v1 (use `BunMot` directly).

### `launch(options)` (`bun-mot/launch`)

Spawn → wait for bridge → build `BunMot`, in one call.

| Argument | Type | Required | Description |
|---|---|---|---|
| `options.appPath` | `string` | ✓ | Executable / entry path to spawn. |
| `options.args` | `string[]` |  | Extra argv passed to `appPath`. |
| `options.cwd` | `string` |  | Spawn cwd (default `process.cwd()`). |
| `options.env` | `Record<string,string>` |  | Extra env merged onto `process.env`. `BUN_MOT_PORT` is added automatically. |
| `options.port` | `number` |  | Bridge port. Omit (default) and the child picks one; launch reads it from stdout. |
| `options.hostname` | `string` |  | Bridge host (default `127.0.0.1`). |
| `options.readyTimeout` | `number` |  | Connection wait, ms (default `10000`). |
| `options.defaultTimeout` | `number` |  | `defaultTimeout` for the constructed `BunMot`. |
| `options.echoOutput` | `boolean` |  | Echo child stdout/stderr to the test runner (default `false`). |
| `options.runtime` | `string` |  | Launcher command (default `"bun"`). Override for Node etc. |

Returns: `{ app: LaunchedApp, mot: BunMot }`.

`LaunchedApp`:

- `app.close(): Promise<void>` — SIGTERM, then SIGKILL after 1.5s. Idempotent.
- `app.pid: number` — child PID.
- `app.port: number` — actual listen port (extracted from stdout).
- `app.readStdout() / app.readStderr()` — captured output for debugging.

#### Errors

Every operation throws a `BunMotError` subclass on failure.

| Class | `kind` | Raised when |
|---|---|---|
| `BunMotTimeoutError` | `timeout` | `waitForSelector` / `waitForHidden` / `waitForText` time out |
| `BunMotSelectorNotFoundError` | `selector_not_found` | `getText` / `click` / `fill` / `getAttribute` finds nothing |
| `BunMotElementNotInteractableError` | `element_not_interactable` | `click` target isn't `HTMLElement`, `fill` target isn't `<input>` / `<textarea>` |
| `BunMotEvaluationError` | `evaluation_error` | The expression in `evaluate` threw |
| `BunMotError` (base) | `validation_error` / `internal_error` | Protocol violation / internal bug |

## Console Logs

bun-mot captures `console.log` / `console.warn` / `console.error` from the WebView into an in-memory buffer.

### Spec

- **Buffer cap**: 1000 entries (FIFO drop). When entries are dropped, `getLogs()` prepends a warn entry `[bun-mot] dropped N earlier log entries`.
- **Patch timing**: lazily injected on the **first command** after the bridge starts. Each subsequent command checks for the patch and re-injects after navigation / reload.
- **Consume on read**: `getLogs()` drains the internal buffer.
- **Entry shape**: `{ level: 'log' | 'warn' | 'error'; message: string; timestamp: number }` (`timestamp` is ms epoch).
- **Argument stringification**: `String(arg)` based; objects / arrays go through `JSON.stringify` best-effort, with `String(arg)` as a fallback for cycles.

### Known limitations

- Output before the patch is injected (i.e. before the first command) is not captured.
- The first `getLogs()` immediately after navigation / reload returns empty plus a warn entry, since the patch has not been re-injected yet. Workaround: call any other command first (e.g. `mot.evaluate('1')`) to trigger re-injection.
- **Bootstrap is best-effort.** The first `console.*` patch injection runs lazily on the first command. If it times out (default 5s, configurable via `setupBunMot({ bootstrapTimeoutMs })`) or rejects, bun-mot logs `console_patch_failed` and continues with your command anyway — `waitForSelector` / `click` / `evaluate` will still work, but `getLogs()` will keep returning `patchMissing: true` until the bridge is restarted. Increase `bootstrapTimeoutMs` if your app's first paint is slow.

### Out of scope

- `console.info` / `console.debug` / `console.trace`
- Crash propagation on patch failure (failures don't break the app's `console.*`)

## Production build exclusion

`bun-mot/bridge` is **test-only** code. Including it in a production build exposes a listening port and an `evaluate` RPC, so always exclude it.

### Recommended: dynamic import + env-var guard

The pattern shown in [Usage §1](#1-app-side-start-the-bridge):

```typescript
if (process.env.BUN_MOT_PORT) {
  const { setupBunMot } = await import("bun-mot/bridge");
  const port = Number(process.env.BUN_MOT_PORT);
  setupBunMot(view, { port });
}
```

Build commands:

```bash
# Production (strip bun-mot from the bundle)
bun build --target=bun --env='BUN_MOT_*' app/main.ts

# E2E run (keep the bridge in)
BUN_MOT_PORT=0 bun build --target=bun --env='BUN_MOT_*' app/main.ts
```

`--env='BUN_MOT_*'` inlines `process.env.BUN_MOT_PORT` (identifier form) as a string literal at build time. With nothing injected it folds to `""`, the `if ("")` branch becomes unreachable, and the import is tree-shaken.

### Measured behavior (Bun bundler, 2026-05)

`test/integration/prod-build.test.ts` exercises `bun build --target=bun --env='BUN_MOT_*'` (**without `--minify`**) and asserts:

| Build env | Output size | `setupBunMot` identifier | Bridge internal literal (`"command_received"`) |
|---|---|---|---|
| `BUN_MOT_PORT=""` (unset) | 141 bytes | **absent** | **absent** |
| `BUN_MOT_PORT="4747"` | ~145 KB | present | present |

> With `--minify` identifiers get mangled and the identifier-based assertion gets false positives. Verify with **minify off**.

### Alternative: `--define` for builders without dynamic-import dead-code elimination

```typescript
// app/main.ts
declare const __BUN_MOT_ENABLED__: boolean;

if (__BUN_MOT_ENABLED__) {
  const { setupBunMot } = await import("bun-mot/bridge");
  setupBunMot(view, { port: 4747 });
}
```

```bash
# Production (substitute identifier with false → if (false) → removed)
bun build --target=bun --define '__BUN_MOT_ENABLED__=false' app/main.ts
# (esbuild and Vite have equivalent --define / define options)
```

### Quick residual check (also covered in FAQ)

```bash
grep -E "setupBunMot|command_received" dist/main.js && echo "still there" || echo "OK"
```

## FAQ

### Q. How do I confirm bun-mot is not in my production bundle?

Grep for both the identifier and an internal literal:

```bash
grep -E "setupBunMot|command_received|command_validation_failed" dist/main.js
```

No output = stripped. Verify with `--minify` off (minified identifiers get mangled and the grep won't match).

### Q. `evaluate` returns the unresolved promise for an `await`-style expression

Some WebViews don't support the async (Promise-completion) form of `evaluateJavascriptWithResponse`. bun-mot's WaitFor commands generate Promise-returning scripts internally, so a synchronous-only Electrobun build can break them. Confirm you are on an Electrobun build with async `evaluateJavascriptWithResponse` support.

### Q. Can I use `mot.view("name")` for multiple views?

The API is shipped from v1, but the bridge routes to a single view, so view switching has no runtime effect yet. The `view()` API is a forward-compatible placeholder. See [§4 Multiple views and the `view()` v1 limitation](#4-multiple-views-and-the-view-v1-limitation).

### Q. Can I import `bun-mot/launch` from my app?

**No**. `bun-mot/launch` is a **test-side** helper. Don't import it from your Electrobun main process — it carries a Node `child_process` fallback that should never end up in your app bundle.

## Limitations

- **Bun runtime required**: `bun-mot` is a Bun-only package (`engines.bun: ">=1.0.0"`). `dist/` is emitted as ES Modules (extensionless imports), Node cannot resolve them, and the runtime depends on `Bun.serve` / `Bun.spawn`. `engines.node` is intentionally absent so users aren't misled into expecting Node compatibility. The Node fallback in `src/launch.ts` (`eval("require")(...)`) is dormant and reserved for future Node support.
- **`fill`**: only `<input>` / `<textarea>`. `<select>` and `contenteditable` are not supported. It does not call `focus()` (a deliberate divergence from Playwright's `fill`).
- **`click`**: invokes `el.click()` only. No actionability check (visible / enabled / stable / overlap). SVG nodes aren't `HTMLElement` and raise `element_not_interactable`.
- **`isVisible`**: doesn't recurse through ancestor `opacity` (matching Playwright's simplification). `aria-hidden` is not considered.
- **`waitForText`**: waits for both the element to exist and the text to match, so a missing selector also waits until timeout (no `selector_not_found` thrown).
- **`screenshot`**: implemented by injecting [`html2canvas`](https://html2canvas.hertzen.com/) into the WebView — see [docs/screenshot-strategy.md](docs/screenshot-strategy.md).
  - Native chrome (titlebar, toolbar, scrollbars) is not captured.
  - Cross-origin `<iframe>` content is not rendered.
  - Some CSS (e.g. `backdrop-filter`) is not perfectly reproduced.
  - Not suitable for pixel-exact visual regression (a future issue).
  - First capture pays a one-time html2canvas inject overhead (~47KB, tens to ~100ms).
  - End-to-end verification of `screenshot` against `test/fixtures/sample-app/` is not in place yet; v0.1 covers it with mocked unit tests only.
- **Console logs**: see "Console Logs > Known limitations".

## Manual verification with `curl`

With the bridge running you can poke it directly:

```bash
# evaluate
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"evaluate","expression":"1+1"}'
# → {"success":true,"result":2}

# waitForSelector
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"waitForSelector","selector":".mermaid svg","timeout":5000}'
# → {"success":true,"result":{"found":true}}
# → on timeout: {"success":false,"error":{"kind":"timeout","message":"__BUNMOT_TIMEOUT__:..."}}

# getText
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"getText","selector":"h1"}'
# → {"success":true,"result":{"text":"Hello"}}

# click
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"click","selector":".btn"}'
# → {"success":true,"result":{"clicked":true}}

# fill
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"fill","selector":"input[name=q]","value":"hello"}'
# → {"success":true,"result":{"filled":true}}

# getLogs
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"getLogs"}'
# → {"success":true,"result":{"entries":[...],"droppedCount":0,"patchMissing":false}}

# screenshot
curl -X POST http://127.0.0.1:4747/command \
  -H "content-type: application/json" \
  -d '{"type":"screenshot","fullPage":true}'
# → {"success":true,"result":{"dataUrl":"data:image/png;base64,...","byteCount":12345}}
```

## Development

```bash
bun install
bun test                      # unit + integration (default)
bun run test:unit             # unit only (used by prepublishOnly)
bun run test:integration      # integration only (spawns the sample-app fixture)
bun run fixture:start         # start the sample-app fixture by hand (for debugging)
bun run typecheck             # tsc --noEmit
bun run build                 # compile to dist/ (.js + .d.ts)
```

`bun run build` uses `tsconfig.build.json` (`compilerOptions.types: []`) so the public `.d.ts` doesn't leak Bun runtime types (`Server<...>`, `Bun.Subprocess`).

### Design notes

- [`docs/design.md`](docs/design.md) — living document covering architecture and design decisions. The README is the canonical source for the API; design.md is the canonical source for the *why*.
- [`docs/screenshot-strategy.md`](docs/screenshot-strategy.md) — investigation log + chosen approach for the `screenshot` command.

## License

MIT
