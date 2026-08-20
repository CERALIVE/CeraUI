/**
 * The operator-visible half of the ONE normalized bind-map disposition — pure,
 * rune-free.
 *
 * The backend owns a typed-disposition producer boundary (the sender's own
 * verdict, or CeraUI's synthesized one for the two launch paths the sender
 * cannot report). This module only CHOOSES COPY for the value that arrives; it
 * never infers a degradation from an absent field, because that inference is
 * how "two modems, one bonded link, no explanation" happened in the first place.
 *
 * `mapped` is the only silent state. Every other disposition says something an
 * operator can act on, and the machine-readable `reason` is resolved to keyed
 * copy rather than rendered raw.
 */

import type { BondCollisionGroup, BondMapping } from "@ceraui/rpc/schemas";

export interface BondMappingBand {
	readonly titleKey: string;
	readonly bodyKey: string;
	/** Keyed copy for the sender's typed reason; absent when it reported none. */
	readonly reasonKey?: string;
	/** `BIND_IPS_FILE` line positions — NOT conn_ids. Empty unless at startup. */
	readonly collisions: readonly BondCollisionGroup[];
}

const COPY = {
	retained_last_valid: {
		titleKey: "network.collision.bindMapDegradedTitle",
		bodyKey: "network.collision.bindMapRetainedBody",
	},
	startup_collision_excluded: {
		titleKey: "network.collision.bindMapCollisionTitle",
		bodyKey: "network.collision.bindMapCollisionBody",
	},
	legacy_unique_only: {
		titleKey: "network.collision.bindMapLegacyTitle",
		bodyKey: "network.collision.bindMapLegacyBody",
	},
} as const;

export function bondMappingBand(
	mapping: BondMapping | null | undefined,
): BondMappingBand | undefined {
	if (!mapping) return undefined;
	if (mapping.disposition === "mapped") return undefined;

	const copy = COPY[mapping.disposition];
	if (copy === undefined) return undefined;

	return {
		titleKey: copy.titleKey,
		bodyKey: copy.bodyKey,
		...(mapping.reason !== undefined
			? { reasonKey: `network.collision.bindMapReason.${mapping.reason}` }
			: {}),
		collisions: mapping.collisions ?? [],
	};
}
