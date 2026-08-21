/**
 * Telling two identical modems apart in the Bonded Links panel — pure,
 * rune-free.
 *
 * Two units of one SKU are identical in every label an operator can read: the
 * bench pair ships ONE factory MAC, one factory LAN subnet and one model name,
 * so both rows render as the same words. What separates them is WHICH PORT each
 * is plugged into, which the backend publishes per link as `port_label` beside
 * the interface name.
 *
 * A serial rides the line ONLY when the device actually reports one — the
 * HiLink twins report none, and inventing one would be worse than the ambiguity
 * it papers over.
 *
 * The line is rendered ONLY for a label more than one row shares. A unique row
 * is already unambiguous, and stamping every link with its ifname is noise that
 * makes the one case that matters harder to notice, not easier.
 */

import type { LinkTelemetryEntry } from "@ceraui/rpc/schemas";

/** Labels rendered by more than one link — the rows that need separating. */
export function ambiguousLinkLabels(
	links: ReadonlyArray<{ readonly label: string }>,
): Set<string> {
	const seen = new Set<string>();
	const ambiguous = new Set<string>();
	for (const link of links) {
		if (seen.has(link.label)) ambiguous.add(link.label);
		seen.add(link.label);
	}
	return ambiguous;
}

/**
 * The identity line for one row, or `undefined` when the row needs none.
 *
 * The interface name is taken from the row itself rather than from telemetry,
 * so twins stay distinguishable before the first telemetry frame arrives; the
 * port label and serial enrich it once the bond has been published.
 */
export function linkDisambiguation(
	link: { readonly id: string; readonly label: string },
	entry: LinkTelemetryEntry | undefined,
	ambiguous: ReadonlySet<string>,
): string | undefined {
	if (!ambiguous.has(link.label)) return undefined;

	const parts = [link.id, entry?.port_label, entry?.serial].filter(
		(part): part is string => Boolean(part) && part !== link.label,
	);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The key a rendered row is identified by.
 *
 * `link_id` is todo 10's minted per-device identity and outranks everything: a
 * SIGHUP that republishes the bond in a different order moves every `conn_id`,
 * and a row keyed on a position follows the position rather than the modem. The
 * interface name is the legacy fallback for a link with no published mapping.
 */
export function linkRowKey(
	link: { readonly id: string },
	entry: LinkTelemetryEntry | undefined,
): string {
	return entry?.link_id ?? link.id;
}
