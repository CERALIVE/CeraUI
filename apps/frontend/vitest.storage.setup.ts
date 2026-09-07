import { beforeEach } from "vitest";

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
 * state leakage. Each project runs this setup before every test file, installing
 * a fresh instance that is disjoint by construction even when the pure project
 * shares its module environment with `isolate: false`.
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
			if (typeof prop === "string" && !Reflect.has(target, prop)) {
				return entries.get(prop);
			}
			return Reflect.get(target, prop, receiver);
		},
		set(target, prop, value, receiver) {
			if (typeof prop === "string" && !Reflect.has(target, prop)) {
				entries.set(prop, String(value));
				return true;
			}
			return Reflect.set(target, prop, value, receiver);
		},
		has(target, prop) {
			return (
				(typeof prop === "string" && entries.has(prop)) || Reflect.has(target, prop)
			);
		},
		deleteProperty(target, prop) {
			if (typeof prop === "string" && entries.has(prop)) {
				entries.delete(prop);
				return true;
			}
			return Reflect.deleteProperty(target, prop);
		},
		ownKeys() {
			return [...entries.keys()];
		},
		getOwnPropertyDescriptor(target, prop) {
			if (typeof prop === "string" && entries.has(prop)) {
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

for (const area of ["localStorage", "sessionStorage"] as const) {
	Object.defineProperty(globalThis, area, {
		value: createMemoryStorage(),
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

// The fresh instance isolates files; this clear keeps tests within one file from
// inheriting each other's persisted keys.
beforeEach(() => {
	globalThis.localStorage.clear();
	globalThis.sessionStorage.clear();
});
