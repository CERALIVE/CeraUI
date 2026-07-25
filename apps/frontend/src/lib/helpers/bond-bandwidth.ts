/**
 * bond-bandwidth.ts — pure, rune-free aggregation of the bonded links' working
 * bandwidth for the Network destination.
 *
 * Extracted from BondedLinksSection so the rule is unit-testable and lives in
 * ONE place.
 */

import type { LinkSignal } from "$lib/types/hud";

/**
 * A link's upstream rate in kbps.
 *
 * Prefers `rateTxKbps` — the interface's measured per-second rate — over the
 * stream-gated `throughputKbps`, which is pinned to 0 whenever no stream is
 * running and therefore cannot report a link that is genuinely carrying
 * traffic. `throughputKbps` remains the fallback for a backend that does not
 * report per-second rates.
 */
export function linkUpKbps(link: LinkSignal): number {
	return link.rateTxKbps ?? link.throughputKbps ?? 0;
}

export type BondBandwidth = {
	upKbps: number;
	downKbps: number;
	/** False when no link reports a downstream rate, so the UI can omit it. */
	hasDownstream: boolean;
};

/** Consolidated bandwidth across every link currently enabled in the bond. */
export function aggregateBondBandwidth(
	links: readonly LinkSignal[],
): BondBandwidth {
	let upKbps = 0;
	let downKbps = 0;
	let hasDownstream = false;

	for (const link of links) {
		if (link.rateRxKbps !== null && link.rateRxKbps !== undefined) {
			hasDownstream = true;
		}
		if (!link.enabled) continue;
		upKbps += linkUpKbps(link);
		downKbps += link.rateRxKbps ?? 0;
	}

	return { upKbps, downKbps, hasDownstream };
}
