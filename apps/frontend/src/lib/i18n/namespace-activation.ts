/**
 * Which i18n namespaces each part of the app needs, and WHEN.
 *
 * Every namespace is its own lazily-imported chunk (`EAGER_NAMESPACES` in the
 * registry generator is empty, and must stay empty — an eager namespace is fused
 * back into the entry chunk, a measured regression). What this module owns is the
 * second half of that design: WHICH chunks are awaited before the app mounts, and
 * which are deferred to the destination that actually reads them.
 *
 * {@link BOOT_NAMESPACES} is everything first paint can read — the auth gate, the
 * layout chrome, the nav, the HUD, the toast/notification surfaces, the PWA and
 * offline pages, the shared dialog chrome, the shell-level stores that render copy
 * of their own (`async-operation`'s failure toast, `Badge`'s stale marker), and
 * the DEFAULT destination's own view. Awaiting these is what keeps first paint
 * atomic: no string can flash as its own dotted key, and "the nav is active" still
 * means "the view is on screen".
 *
 * {@link DESTINATION_NAMESPACES} is the remainder, resolved at the navigation
 * activation point — the same "load it when it is about to be read" shape the lazy
 * config dialogs use.
 *
 * The two sets together cover every namespace by construction (boot is the
 * complement of the destination-claimed set); `namespace-activation.test.ts`
 * fails the build if that stops holding.
 */
import {
	ensureNamespaces,
	isNamespaceLoaded,
	NAMESPACES,
	type Namespace,
} from "@ceraui/i18n/svelte";

/**
 * Keyed by the `navElements` destination key: the namespaces ONLY that destination
 * reads. Everything else boots.
 *
 * `live` is deliberately absent. It is the DEFAULT destination, so its view is
 * part of first paint — deferring `live`/`settings` (the two largest namespaces,
 * ~55% of the catalog) would buy the most, but it splits first paint into two
 * phases: the shell renders, then the operator's primary surface pops in. That is
 * a product decision with its own UX and e2e-contract work, not something to slip
 * into a lazy-loading change. What ships here is the boundary that is true by
 * construction — a namespace no first-paint surface can read is not awaited.
 */
export const DESTINATION_NAMESPACES: Readonly<
	Record<string, readonly Namespace[]>
> = {
	live: [],
	network: ["advanced", "hotspotConfigurator", "wifiSelector"],
	settings: ["advanced"],
	devtools: ["devtools"],
	identity: [],
};

const DEFERRED = new Set<string>(Object.values(DESTINATION_NAMESPACES).flat());

/**
 * The shell set: every namespace that is NOT claimed by a single destination.
 * Derived rather than listed, so a namespace can never be orphaned by an edit
 * that adds it to the catalog but forgets one of the two lists.
 */
export const BOOT_NAMESPACES: readonly Namespace[] = NAMESPACES.filter(
	(ns) => !DEFERRED.has(ns),
);

/** Resolve the shell set. `main.ts` awaits exactly this before it mounts. */
export function ensureBootNamespaces(): Promise<void> {
	return ensureNamespaces(BOOT_NAMESPACES);
}

/**
 * Resolve a destination's namespaces before its view renders. An unrecognised key
 * resolves immediately: a destination with no entry reads shell copy only, which
 * boot already loaded.
 */
export function ensureDestinationNamespaces(key: string): Promise<void> {
	return ensureNamespaces(DESTINATION_NAMESPACES[key] ?? []);
}

/**
 * Whether a destination can render RIGHT NOW, with no fetch and no await.
 *
 * The activation gate is what keeps a view from rendering dotted keys, but paying
 * a promise tick for it when the registry is already populated would delay every
 * navigation for nothing — and "the nav is active" would stop implying "the view
 * is on screen", which both the operator and the e2e helpers rely on.
 */
export function areDestinationNamespacesLoaded(key: string): boolean {
	return (DESTINATION_NAMESPACES[key] ?? []).every(isNamespaceLoaded);
}

/**
 * Warm the deferred namespaces AFTER mount, without blocking it.
 *
 * The activation gate is the correctness guarantee; this is the latency one. It
 * turns the common navigation into the synchronous path above while leaving first
 * paint waiting on the shell set alone — a destination reached before its warm-up
 * lands still gates correctly, it just waits for its own chunks.
 */
export function prefetchDeferredNamespaces(): void {
	const deferred = NAMESPACES.filter((ns) => !isNamespaceLoaded(ns));
	void ensureNamespaces(deferred).catch(() => {
		// A failed warm-up is not an error path: the activation gate re-requests
		// the namespace when the destination is actually opened.
	});
}

/** Namespaces in neither set — always empty; the test gate asserts it. */
export function orphanNamespaces(): Namespace[] {
	const covered = new Set<string>(BOOT_NAMESPACES);
	for (const list of Object.values(DESTINATION_NAMESPACES)) {
		for (const ns of list) covered.add(ns);
	}
	return NAMESPACES.filter((ns) => !covered.has(ns));
}
