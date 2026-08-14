import { afterAll, beforeEach } from 'vitest';

/**
 * Deterministic in-memory Web Storage, installed over `globalThis` before any
 * store module loads.
 *
 * Node 25 shipped a built-in `globalThis.localStorage`/`sessionStorage` pair
 * that is `undefined` unless the process was started with `--localstorage-file`.
 * Vitest's jsdom environment only copies a window key onto the global when the
 * global does not already own it, and it aliases `globalThis.window` back to
 * `globalThis` — so on Node >= 25 jsdom's real Storage is skipped and every
 * `window.localStorage` read resolves to that empty built-in. That is what makes
 * `$persist` (svelte-persistent-runes) throw
 * `TypeError: Cannot read properties of undefined (reading 'getItem')` at module
 * scope, taking down every spec that transitively imports `$lib/utils`.
 *
 * `--localstorage-file` is NOT the fix: one fixed path is shared by every worker
 * and survives across runs, which turns the hard failure into silent cross-spec
 * state leakage. A fresh instance installed here is disjoint by construction —
 * vitest runs setup files before EACH test file under `isolate: true`, so no two
 * spec files can ever observe each other's writes.
 */
function createMemoryStorage(): Storage {
	const entries = new Map<string, string>();
	const api = {
		get length(): number {
			return entries.size;
		},
		key(index: number): string | null {
			return [...entries.keys()][index] ?? null;
		},
		getItem(key: string): string | null {
			return entries.get(String(key)) ?? null;
		},
		setItem(key: string, value: string): void {
			entries.set(String(key), String(value));
		},
		removeItem(key: string): void {
			entries.delete(String(key));
		},
		clear(): void {
			entries.clear();
		},
	};

	// Web Storage also exposes every stored key as a named property
	// (`storage.foo === storage.getItem('foo')`), which jsdom implements too.
	return new Proxy(api, {
		get(target, prop, receiver) {
			if (typeof prop === 'string' && !Reflect.has(target, prop)) {
				return entries.get(prop);
			}
			return Reflect.get(target, prop, receiver);
		},
		set(target, prop, value, receiver) {
			if (typeof prop === 'string' && !Reflect.has(target, prop)) {
				entries.set(prop, String(value));
				return true;
			}
			return Reflect.set(target, prop, value, receiver);
		},
		has(target, prop) {
			return (
				(typeof prop === 'string' && entries.has(prop)) || Reflect.has(target, prop)
			);
		},
		deleteProperty(target, prop) {
			if (typeof prop === 'string' && entries.has(prop)) {
				entries.delete(prop);
				return true;
			}
			return Reflect.deleteProperty(target, prop);
		},
		ownKeys() {
			return [...entries.keys()];
		},
		getOwnPropertyDescriptor(target, prop) {
			if (typeof prop === 'string' && entries.has(prop)) {
				return {
					value: entries.get(prop),
					writable: true,
					enumerable: true,
					configurable: true,
				};
			}
			return Reflect.getOwnPropertyDescriptor(target, prop);
		},
	}) as Storage;
}

for (const area of ['localStorage', 'sessionStorage'] as const) {
	Object.defineProperty(globalThis, area, {
		value: createMemoryStorage(),
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

// Per-file isolation is structural (a fresh Storage per setup-file run); this
// keeps tests WITHIN a file from inheriting each other's persisted keys.
beforeEach(() => {
	globalThis.localStorage.clear();
	globalThis.sessionStorage.clear();
});

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
