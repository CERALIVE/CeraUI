import { spyOn } from "bun:test";
import * as fs from "node:fs";
import type { HotspotActivationDeps } from "../../modules/wifi/wifi-hotspot-types.ts";

/** Positive mode fixtures use the qualified card; unqualified-card controls keep their own driver. */
export function mockQualifiedHybridDriver() {
	return spyOn(fs, "realpathSync").mockReturnValue(
		"/sys/bus/pci/drivers/mt7925e",
	);
}

/** These unit fixtures own an admitted SCC station and a ready fake allocation. */
export const qualifiedHybridEvidence = {
	readHybridChannel: async (ifname: string) => ({
		identity: `qualified-fixture:${ifname}`,
		frequency: 2412,
		sameChannelOnly: true,
		fields: {
			"802-11-wireless.band": "bg",
			"802-11-wireless.channel": "1",
		},
	}),
	validateConcurrentInterface: async () => true,
	confirmHybridActivation: async () => true,
} satisfies Pick<
	HotspotActivationDeps,
	| "readHybridChannel"
	| "validateConcurrentInterface"
	| "confirmHybridActivation"
>;
