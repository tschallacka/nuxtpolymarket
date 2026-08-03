---
name: playwright-game-debug
description: Debug Pathwarden with Playwright using its development-only bridge. Use for Pathwarden visual defects, canvas interaction failures, responsive layouts, runtime state inspection, browser console errors, screenshots, traces, or automated smoke tests. Other games intentionally have no development bridge.
---

# Playwright Game Debug

Use the development bridge before relying on coordinate guesses. It is available only in a Nuxt development build as `window.__POLYNUX_DEV_BRIDGE__`; never enable it in production.

## Workflow

1. Start PostgreSQL with `docker compose up -d postgres`.
2. Start Nuxt with `bun run dev`.
3. Reuse an installed Playwright dependency. If absent and browser automation is required, add it with Bun only.
4. Sign in through the UI or API and retain Playwright storage state when the route is protected.
5. Navigate to Pathwarden and wait for its registered bridge ID.
6. Inspect bridge state before taking screenshots or clicking coordinates.
7. Capture console errors, failed requests, a trace, and screenshots at the relevant viewport.
8. Reproduce at least once after the fix and keep assertions based on stable state or labels.

## Bridge API

Evaluate the bridge inside the page:

```ts
const games = await page.evaluate(() => window.__POLYNUX_DEV_BRIDGE__?.list())

await page.evaluate(async () => {
await window.__POLYNUX_DEV_BRIDGE__?.waitFor()
})

const inspection = await page.evaluate(() =>
  window.__POLYNUX_DEV_BRIDGE__?.inspect()
)

await page.evaluate(() =>
  window.__POLYNUX_DEV_BRIDGE__?.run('togglePause')
)
```

`list()` returns the Pathwarden descriptor and named actions. `inspect()` returns serializable canvas dimensions and the canonical state from `PathwardenEngine.getDebugState()`. `run(action, input?)` invokes an explicitly registered Pathwarden development action. `waitFor(timeoutMs?)` waits for asynchronous Pathwarden initialization.

Current ID:

- `pathwarden`

Other games deliberately do not register a bridge. Use their visible DOM controls and normal pointer interaction for browser checks.

## Visual debugging

Prefer `locator.screenshot()` on the canvas or containing game card. Use `page.screenshot({ fullPage: true })` for layout defects. Set an explicit viewport and device scale factor. Treat small WebGL pixel differences as noise unless the environment is fixed.

For interaction:

- Prefer DOM controls and accessible names around the canvas.
- Use bridge actions for engine-only operations.
- Use canvas-relative coordinates only when testing pointer mechanics.
- Read `inspect(id).canvas` before translating design coordinates to CSS pixels.

## Extending the bridge

Pathwarden uses `registerPathwardenDevBridge` from `app/utils/pathwarden-dev-bridge.ts`. Its inspection state is obtained directly from `PathwardenEngine.getDebugState()`; do not create a second manually maintained state object. Provide only narrowly scoped named actions and always call the returned unregister function during teardown.

Other games must not register with a bridge or pass bridge IDs through shared bootstraps. Their gameplay state belongs only to their own component and server API.

Guard the Pathwarden integration with `import.meta.dev` and dynamically import `pathwarden-dev-bridge.ts` inside that guard. Do not statically import the bridge from the component. This keeps the bridge module out of production bundles.

Never expose secrets, session tokens, arbitrary code execution, database mutation helpers, or production-only state through the bridge.

## Test expectations

Assert in this order:

1. No unexpected console errors or failed requests.
2. The expected bridge ID appears.
3. Canvas dimensions are non-zero and connected.
4. Relevant game state or scene labels match.
5. The visual screenshot is correct.

Keep screenshot baselines, traces, and videos out of version control unless the task explicitly adds a maintained Playwright suite.
