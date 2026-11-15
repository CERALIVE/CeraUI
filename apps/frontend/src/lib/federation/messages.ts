import {
	advanced,
	audio,
	common,
	dialogs,
	errorBoundary,
	general,
	live,
	network,
	networking,
	notifications,
	registerNamespaces,
	settings,
	units,
	validation,
	wifiBands,
} from "@ceraui/i18n/eager";
import { setLocale } from "@ceraui/i18n/svelte";

// Only the namespaces the three dialogs render; the rest stay out of the bundle.
// tests/federation/federation-namespaces.test.ts fails if a bundle references another.
const FEDERATION_CATALOG = {
	advanced,
	audio,
	common,
	dialogs,
	errorBoundary,
	general,
	live,
	network,
	networking,
	notifications,
	settings,
	units,
	validation,
	wifiBands,
};

export const FEDERATION_NAMESPACES: readonly string[] =
	Object.keys(FEDERATION_CATALOG);

let registered = false;

/**
 * Loads the dialogs' message catalog into a federation bundle, statically.
 *
 * The SPA registers namespaces through `ensureAllNamespaces()`, which resolves
 * lazily-imported per-namespace chunks — that split is what keeps the ten-locale
 * Paraglide catalog out of its entry chunk. A federation bundle cannot use it:
 * the platform fetches ONE hosted module under a strict CSP, against a signed
 * manifest that pins an exact chunk graph, so a sibling chunk the manifest never
 * described is unreachable and every string would render as its own dotted key.
 *
 * Called at module scope by each dialog entry, so the catalog is in the registry
 * before the host can call `mountDialog`. The three entries share this module,
 * so only the first successful call writes the registry.
 */
export function registerFederationMessages(): void {
	if (registered) return;
	registerNamespaces(FEDERATION_CATALOG);
	registered = true;
}

/** Applies the host's requested locale, if it sent one. An unknown code falls back. */
export function applyFederationLocale(locale: string | undefined): void {
	if (locale !== undefined) setLocale(locale);
}
