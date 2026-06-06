import { afterAll } from 'vitest';

/**
 * bits-ui body-scroll-lock teardown guard.
 *
 * Every Dialog/Sheet surface (all 14 AppDialog-based dialogs) installs a
 * `BodyScrollLock`. When the LAST lock is destroyed — i.e. when the final dialog
 * in a test file unmounts during @testing-library/svelte's auto-cleanup — bits-ui
 * schedules an async `resetBodyStyle()` via `setTimeout(..., 24ms)`
 * (node_modules/bits-ui/dist/internal/body-scroll-lock.svelte.js). That deferred
 * callback touches `document.body`.
 *
 * The `if (!BROWSER) return` guard inside `resetBodyStyle` does NOT protect us:
 * vitest.config.ts sets `resolve.conditions: ['browser']`, so esm-env resolves
 * `BROWSER === true`. If the 24ms timer fires AFTER vitest tears down the jsdom
 * environment for the file, the global `document` binding is gone and it throws
 * `ReferenceError: document is not defined` (originating from whichever dialog
 * test happened to unmount last — see bits-ui issue #1639 for the timer design).
 *
 * Intermediate per-test timers are cancelled by the next render's
 * `cancelPendingCleanup()`, so only the final file-level timer is ever at risk.
 * Wait past the 24ms cleanup delay once per file, while the environment (and
 * `document`) is still alive, so the timer fires harmlessly before teardown. The
 * bits-ui timer is scheduled during the last test's cleanup (just before this
 * hook), so a 50ms wait deterministically outlasts it. In the `node` environment
 * no dialog renders and no such timer is ever scheduled, so this is a no-op wait.
 */
afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, 50));
});
