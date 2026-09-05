import { registerAllNamespaces } from "@ceraui/i18n/eager";
import { afterAll } from "vitest";

/**
 * jsdom does not implement matchMedia. Most component suites install a tailored
 * mock, but source-only imports such as NavigationHelper still evaluate PWA code
 * before their own hooks run. Supply the inert browser default at project setup;
 * a test remains free to replace it with a query-aware mock.
 */
if (typeof window.matchMedia !== "function") {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string): MediaQueryList => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		}),
	});
}

/**
 * bits-ui body-scroll-lock teardown guard.
 *
 * Every Dialog/Sheet surface installs a `BodyScrollLock`. When the final lock in
 * a test file unmounts during Testing Library cleanup, bits-ui schedules
 * `resetBodyStyle()` after 24 ms. Waiting once per component file keeps jsdom's
 * `document` alive until that timer has fired; pure files never pay this cost.
 *
 * SLEEP RETAINED: bits-ui's timer is WALL-CLOCK, so it cannot be drained.
 * `scheduleCleanupIfNoNewLocks` arms `window.setTimeout(cleanupFn, 24)`
 * (`bits-ui/dist/internal/body-scroll-lock.svelte.js:75-76`), and `cleanupFn` is
 * what calls `resetBodyStyle()` — which touches `document.body`. A deterministic
 * teardown was measured and rejected: explicit `cleanup()` from
 * `@testing-library/svelte`, then `await tick()`, then a `setTimeout(…, 0)`
 * macrotask drain still left the lock's five properties in place
 * (`--scrollbar-width`, `overflow`, `pointer-events`, `padding-right`,
 * `margin-right`), because a 0 ms macrotask cannot advance a 24 ms timer. Only
 * real elapsed time clears it. Fake timers are no escape either: the timer is
 * armed during Testing Library's own `afterEach`, so it is already pending on the
 * real clock before any `afterAll` could install `vi.useFakeTimers()`, and
 * `vi.runOnlyPendingTimers()` would never see it.
 *
 * The cost is bounded and small — this runs once per component FILE, not per
 * test — so the correct trade is to keep the wait rather than race the timer
 * against jsdom teardown and reintroduce `ReferenceError: document is not
 * defined`.
 */
afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, 50));
});

/**
 * Component tests mount below `main.ts`, so they do not run the application's
 * namespace activation. Register the full generated catalog before rendering.
 */
registerAllNamespaces();
