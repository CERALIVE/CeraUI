# E2E Playwright Testing Playbook

> **REQUIRED reading before writing any E2E test in this repo.**
> Playwright version: 1.60.0. Test runner: `pnpm --filter frontend run test:e2e`.

---

## Why Screenshots Are Token-Expensive

Screenshots are the worst default for LLM-driven test authoring. A single PNG from a 1280×720 viewport is 50–200 KB of raw pixel data — the equivalent of thousands of tokens just to describe what a button looks like. An ARIA snapshot of the same view is a compact YAML tree, typically 10–50x smaller, and it carries semantic meaning the model can reason about directly.

ARIA snapshots are also cross-browser stable. A PNG changes with every font-rendering tweak, anti-aliasing difference, or animation frame. The ARIA tree doesn't. It supports partial matching and regex patterns, so you can pin the structure you care about and ignore the parts that legitimately vary (live telemetry, timestamps, dynamic IDs).

Screenshots belong in exactly one place: visual regression tests for graphic refactors, where pixel fidelity is the actual thing being tested. Everywhere else, they're noise.

---

## Assertion Decision Tree

Pick the first branch that fits your assertion. Work top-down.

```
1. Interactive control (button, link, input)
   → getByRole + toBeEnabled() / toBeDisabled() / toBeVisible()

2. Form field value
   → getByLabel + toHaveValue('expected')

3. Status indicator or ARIA attribute
   → toHaveAttribute('aria-*', 'value')  OR  toHaveText('Expected label')

4. Dialog or modal structure
   → getByRole('dialog', { name: '...' }) + toMatchAriaSnapshot(...)
     EXCLUDE dynamic text (bitrate numbers, dBm, temperatures) from the snapshot

5. Navigation / active destination
   → toHaveAttribute('aria-current', 'page')

6. Visual regression of a graphic refactor
   → toHaveScreenshot()  — ONLY in tests/e2e/visual/*.visual.spec.ts tagged @visual
```

If you're reaching for `toHaveScreenshot()` outside a `@visual` file, go back to step 1.

---

## Hard Rules

These are enforced by fixture throws and a CI grep gate. Violations fail the build.

- **No `page.screenshot()` or `toHaveScreenshot()` in functional specs.** The screenshot fixture throws if called outside a `@visual` file. CI also greps for these calls and fails the run.
- **No `waitForTimeout()` anywhere.** It's a sleep. Sleeps are races. Use web-first assertions (`toBeVisible`, `toHaveAttribute`, `expect.poll`) — they auto-retry until the condition is true or the timeout expires.
- **No hardcoded `#nav-tab-*` selectors in specs.** Use `navigateTo()` from `helpers/index.ts`. It handles both the desktop rail (`#nav-tab-*`) and the mobile dock (`#mobile-nav-tab-*`) by checking which is visible.
- **Never put HUD live values in ARIA snapshots.** Bitrate numbers, signal dBm, temperatures, and timestamps change on every render. Snapshots that include them will flake immediately. Exclude them with `...` or regex patterns.
- **`field-lock.spec.ts` is the model spec for complex WebSocket-driven behavioral tests.** Read it before writing anything that involves WebSocket state, optimistic UI, or reconnect behavior. Do not modify it.

---

## Standard Password and Auth Reset

**Test password:** `12345678` (8 characters, satisfies the Zod `min(8)` constraint).

Configured via the `E2E_PASSWORD` environment variable. The default is set in `helpers/index.ts`:

```typescript
const password = process.env.E2E_PASSWORD ?? '12345678';
```

**Auth reset** (required before deterministic set-password tests):

```bash
# Option 1: dedicated script
pnpm --filter frontend run test:e2e:reset

# Option 2: direct file removal
rm -f apps/backend/auth_tokens.json
```

Why this matters: the backend persists auth tokens in `apps/backend/auth_tokens.json`. If that file exists with a valid token, the app skips the set-password flow and goes straight to login. Tests that need to exercise the first-run "set password" branch must clear this file first so the branch is reachable.

---

## Reporters

| Context | Reporter | Why |
|---------|----------|-----|
| CI (`CI=true`) | `line` | Terse, token-efficient. Set automatically. |
| Local dev | `list` | Human-readable per-test output. |
| Reviewing failures | `html` | Rich trace viewer. Use interactively only. |

Avoid committing `html` reporter config. It generates large artifacts and is not useful in automated runs.

---

## How to Read UI State Without Screenshots

```typescript
// Read the ARIA tree — best for dialog and region structure
const yaml = await locator.ariaSnapshot();

// Read text content
const text = await locator.textContent();

// Read an ARIA attribute
const expanded = await button.getAttribute('aria-expanded');

// Web-first assertions — auto-wait and auto-retry
await expect(locator).toBeVisible();
await expect(locator).toHaveText('Expected');
await expect(locator).toMatchAriaSnapshot('- dialog "Dialog Title"');

// Poll for async state (use when no DOM signal exists yet)
await expect.poll(
  async () => page.evaluate(() => window.__cera.lastSetBitrate),
  { timeout: 5000, message: 'setBitrate should fire' }
).toBeGreaterThan(0);
```

`toMatchAriaSnapshot` supports partial matching: you only need to include the nodes you care about. Omit dynamic children with `...`.

---

## When Screenshots ARE Allowed

Screenshots are only permitted in:

```
tests/e2e/visual/*.visual.spec.ts
```

Files must be tagged `@visual` and use `toHaveScreenshot()` with committed baseline images.

```bash
# Update baselines after an intentional visual change
pnpm --filter frontend run test:e2e:visual -- --update-snapshots

# Run the visual suite
pnpm --filter frontend run test:e2e:visual

# From the workspace root
pnpm run test:e2e:visual
```

Baseline images are committed to the repo. A PR that changes them requires a deliberate `--update-snapshots` run and a reviewer sign-off that the visual change was intentional.

---

## Page Object and Fixture Usage

Always import `test` and `expect` from the local fixtures, not directly from `@playwright/test`. The fixtures wire up `authedPage`, the screenshot guard, and other shared setup.

```typescript
// Always import from fixtures, not @playwright/test directly
import { test, expect } from '../fixtures/index.js';
import { ShellPage } from '../pages/shell.js';
import { navigateTo } from '../helpers/index.js';

test('live destination loads', async ({ authedPage: page }) => {
  const shell = new ShellPage(page);
  await shell.navigate('live');
  await shell.assertAuthedShell();

  // Verify by role — NOT screenshot
  await expect(page.getByRole('main')).toBeVisible();
});
```

The `authedPage` fixture handles the full auth flow (first-run set-password or returning login) via `ensureAuthenticated()` from `helpers/index.ts`. Don't replicate that logic in individual tests.

---

## Dialog Testing Pattern

Use `openDialog` and `closeDialog` from `helpers/aria.js` to open and close dialogs by accessible name. Assert structure with `toMatchAriaSnapshot` — not screenshots.

```typescript
import { openDialog, closeDialog } from '../helpers/aria.js';

test('encoder dialog opens and closes', async ({ authedPage: page }) => {
  await navigateTo(page, 'live');

  // Find the trigger by role and accessible name
  const trigger = page.getByRole('button', { name: /encoder/i });
  await openDialog(page, trigger, 'Encoder Settings');

  // Assert dialog structure — no form submission, no screenshot
  await expect(page.getByRole('dialog', { name: 'Encoder Settings' })).toBeVisible();

  await closeDialog(page, 'Encoder Settings');
  await expect(page.getByRole('dialog', { name: 'Encoder Settings' })).toBeHidden();
});
```

All 14 config dialogs in this app compose `AppDialog.svelte`, which renders as a Dialog on desktop and a Sheet on mobile. The accessible name is always the dialog title string. Test against that name, not an ID or class.

---

## Model Spec: `field-lock.spec.ts`

`tests/e2e/field-lock.spec.ts` is the canonical example for complex, WebSocket-driven behavioral tests. Read it before writing anything that involves:

- Optimistic UI (field locks, pending states)
- WebSocket state injection or interception
- Reconnect and replay behavior
- `dev.emit` broadcast-driven assertions

Key patterns it demonstrates:

- **`addInitScript`** to install a WebSocket harness before the page loads, without touching app source code
- **Token rewrite** to authenticate without knowing the device password (reads `auth_tokens.json` at test startup)
- **`expect.poll`** instead of `waitForTimeout` for async state that has no immediate DOM signal
- **`emit(page, type, payload)`** to inject server echoes at known times, making timing deterministic
- **Serial test ordering** (`test.describe.configure({ mode: 'serial' })`) for stateful integration sequences
- **Evidence files** written to the repo-local `test-results/` (gitignored) via `evidencePath()` from `helpers/index.ts`

Do not modify `field-lock.spec.ts`. It is a deterministic integration proof and a reference implementation.

---

## Accessibility Gate (`a11y.spec.ts`)

`a11y.spec.ts` is the axe-core CI gate. It runs `@axe-core/playwright` on the live/network/settings destinations and fails the build ONLY on `critical` + `serious` impact violations. Pre-existing violations are baselined per-page in `a11y-baseline.json` (a rule-id allowlist), so the gate never breaks CI on day one — only a NEW critical/serious rule fails it.

- Runs serial + desktop-only (one worker owns the shared evidence/allowlist files).
- Helper: `helpers/axe.ts` `runAxe(page)` returns only the gated (critical/serious) violations.
- Refresh the baseline after an intentional change: `UPDATE_A11Y_BASELINE=1 pnpm --filter frontend exec playwright test a11y.spec.ts --project=desktop -g "axe gate"`. Capture mode rewrites the allowlist and `test-results/task-7-a11y-baseline.json` and never fails. A normal run writes `test-results/task-7-a11y-gate.json` and enforces.
- All three tests are tagged `@a11y`; the dedicated CI step runs them and the broad Functional E2E step grep-inverts `@a11y` to avoid a duplicate dev-server boot.
- To prove the gate works, seed a violation with a rule id NOT already baselined (e.g. an `<img>` without `alt` → `image-alt`). Seeding more `color-contrast` will be tolerated — it is the baselined rule.

## navigateTo Helper

`navigateTo(page, destination)` from `helpers/index.ts` is the only correct way to navigate between the three primary destinations in specs.

```typescript
import { navigateTo } from './helpers/index.js';

// Valid destinations: 'live' | 'network' | 'settings'
await navigateTo(page, 'live');
await navigateTo(page, 'network');
await navigateTo(page, 'settings');
```

It clicks whichever nav control is currently visible (desktop rail or mobile dock) and asserts `aria-current="page"` before returning. This means the navigation is confirmed before your next assertion runs — no extra `toBeVisible` needed.

Never hardcode `#nav-tab-live` or `#mobile-nav-tab-live` in a spec. The helper exists precisely to abstract that detail.
