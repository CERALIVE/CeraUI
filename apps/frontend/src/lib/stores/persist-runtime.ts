/**
 * The `$persist` RUNTIME, supplied by CeraUI rather than by the package.
 *
 * `svelte-persistent-runes` is two things: a Vite/Svelte PREPROCESSOR that
 * rewrites `$persist(initial, key, options)` into `$state(...)` plus
 * `__persist.load` / `__persist.save` calls, and a tiny RUNTIME that implements
 * those two functions. CeraUI keeps the preprocessor (`vite.config.ts` imports
 * `svelte-persistent-runes/plugins`) and substitutes this module for the runtime
 * through an EXACT-match `resolve.alias` on the bare specifier.
 *
 * WHY: the package's runtime entry re-exports a registry of eleven interchangeable
 * serializer/storage presets — `next-json`, `superjson`, `devalue`, `esserializer`,
 * `php-serialize`, `serialize-anything`, `@macfja/serializer`, `sjcl-es`,
 * `sjcl-codec-hex`, `browser-cookies`, `deep-copy-all` — and it does so in a shape
 * no bundler can shake. `dist/index.mjs` carries a BARE side-effect `import` of
 * each one, and `dist/options.mjs` instantiates every preset in a single fused
 * declaration (`const A=F(),B=y(),C=v(),…`) whose first declarator IS the default
 * the runtime uses. One live declarator keeps the whole statement, the whole
 * statement keeps every factory call, and every factory call keeps its library.
 * Measured on this tree: 427,866 raw / 78.1 KiB gzip of the shipped SPA, reachable
 * by nothing — `rollupOptions.treeshake.moduleSideEffects` recovers only 3.5 KiB
 * of it, because the fused declaration is a tree-shaking problem rather than a
 * side-effect one.
 *
 * Every `$persist` call site in this app (`display-profile`, `layout-mode`,
 * `locale`, `onboarding`, `theme`, `version`) passes exactly two arguments, so all
 * eleven presets are dead by construction: the resolved options are always the
 * package's own defaults — `JSON.stringify`/`JSON.parse` over `window.localStorage`,
 * both of which are inline code with no dependencies at all.
 *
 * This is a SUBSTITUTION, not a fork: the observable behaviour below is the
 * package's default path reproduced exactly, INCLUDING the parts that look like
 * accidents and are not — `storageRead` collapsing `""` to `undefined`, `load`
 * deserializing only a `string`, `save` ignoring `undefined`, and a caller-supplied
 * `options` object still overriding the defaults per key. What is deliberately NOT
 * reproduced is the preset registry: a call site that wants one must import it from
 * `svelte-persistent-runes/options` itself, which fails the build loudly rather than
 * silently resolving to a preset this module does not have.
 *
 * `src/tests/persist-runtime.test.ts` pins the equivalence against the REAL package,
 * so an upstream change to `load`/`save` reddens the suite instead of drifting.
 */
import type { PersistentRunesOptions } from "svelte-persistent-runes";

/** The package's `JsonSerializerFactory(undefined)`. */
const jsonSerializer: Pick<
	PersistentRunesOptions,
	"serialize" | "deserialize"
> = {
	serialize(input) {
		return JSON.stringify(input);
	},
	deserialize(input) {
		return JSON.parse(input);
	},
};

/**
 * The package's `BrowserLocalStorage`.
 *
 * The `window` guard is what keeps an SSR/Node import inert, and the trailing
 * `|| undefined` is load-bearing: `getItem` answers `null` for an absent key and
 * `""` for a stored empty string, and the package folds BOTH into `undefined` so
 * `load` skips them. Narrowing that to a `null` check would start feeding `""` to
 * `JSON.parse` and throw where the package returned the initial value.
 */
const browserLocalStorage: Pick<
	PersistentRunesOptions,
	"storageRead" | "storageWrite"
> = {
	storageWrite(key, value) {
		if (globalThis?.window && "localStorage" in globalThis.window) {
			globalThis.window.localStorage.setItem(key, value);
		}
	},
	storageRead(key) {
		return (
			(globalThis?.window &&
				"localStorage" in globalThis.window &&
				globalThis.window.localStorage.getItem(key)) ||
			undefined
		);
	},
};

function resolveOptions(
	options: Partial<PersistentRunesOptions> | undefined,
): PersistentRunesOptions {
	return { ...jsonSerializer, ...browserLocalStorage, ...options };
}

/** Restore a persisted value, or `undefined` when nothing usable is stored. */
export function load<T>(
	key: string,
	options?: Partial<PersistentRunesOptions>,
): T | undefined {
	const resolved = resolveOptions(options);
	const raw = resolved.storageRead(key);
	return typeof raw === "string" ? resolved.deserialize<T>(raw) : undefined;
}

/** Persist a value. `undefined` is a no-op — it is the "nothing to store" value. */
export function save<T>(
	key: string,
	value: T,
	options?: Partial<PersistentRunesOptions>,
): void {
	if (value === undefined) return;
	const resolved = resolveOptions(options);
	resolved.storageWrite(key, resolved.serialize(value));
}

export type { PersistentRunesOptions };
