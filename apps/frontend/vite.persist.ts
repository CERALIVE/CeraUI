import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Matches the `svelte-persistent-runes` RUNTIME entry and nothing else.
 *
 * Anchored on purpose. Vite's string aliases are prefix matches, so a bare
 * `"svelte-persistent-runes"` entry would also capture `.../plugins` — the
 * PREPROCESSOR this config imports and depends on — and `.../options`, the preset
 * registry a future call site is meant to be able to reach explicitly. Only the
 * bare specifier the preprocessor emits (`import * as __persist from
 * "svelte-persistent-runes"`) is substituted.
 */
export const PERSIST_RUNTIME_SPECIFIER = /^svelte-persistent-runes$/;

const PERSIST_RUNTIME_MODULE = path.resolve(
	__dirname,
	"./src/lib/stores/persist-runtime.ts",
);

/**
 * Serves CeraUI's own `$persist` runtime in place of the package's.
 *
 * The package's runtime entry statically pulls eleven interchangeable
 * serializer/storage presets that no `$persist` call site in this app can reach,
 * in a shape no bundler can shake — 427,866 raw / 78.1 KiB gzip of the shipped
 * SPA. `src/lib/stores/persist-runtime.ts` documents the exact mechanism and
 * reproduces the package's default path; `src/tests/persist-runtime.test.ts` pins
 * the two implementations to the same observable behaviour.
 *
 * Both SPA and federation builds use it, so a federated dialog that reads a
 * `$persist` store carries the same runtime the SPA does.
 */
export const PERSIST_RUNTIME_ALIAS = {
	find: PERSIST_RUNTIME_SPECIFIER,
	replacement: PERSIST_RUNTIME_MODULE,
} as const;
