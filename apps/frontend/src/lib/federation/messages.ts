import { registerAllNamespaces } from "@ceraui/i18n/eager";
import { setLocale } from "@ceraui/i18n/svelte";

/**
 * Loads the message catalog into a federation bundle, statically.
 *
 * The SPA registers namespaces through `ensureAllNamespaces()`, which resolves
 * lazily-imported per-namespace chunks — that split is what keeps the ten-locale
 * Paraglide catalog out of its entry chunk. A federation bundle cannot use it:
 * the platform fetches ONE hosted module under a strict CSP, against a signed
 * manifest that pins an exact chunk graph, so a sibling chunk the manifest never
 * described is unreachable and every string would render as its own dotted key.
 *
 * Called at module scope by each dialog entry, so the catalog is in the registry
 * before the host can call `mountDialog`.
 */
export function registerFederationMessages(): void {
	registerAllNamespaces();
}

/** Applies the host's requested locale, if it sent one. An unknown code falls back. */
export function applyFederationLocale(locale: string | undefined): void {
	if (locale !== undefined) setLocale(locale);
}
