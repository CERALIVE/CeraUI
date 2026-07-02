import type { NetifMessage } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { deriveIngestReadiness } from "./ingestReadiness";

/** Build a netif entry with the required `tp` and `enabled` fields. */
function entry(enabled: boolean, ip?: string): NetifMessage[string] {
	return { enabled, tp: 0, ...(ip !== undefined ? { ip } : {}) };
}

describe("deriveIngestReadiness", () => {
	it("returns empty for an undefined map (pre-snapshot, loading-safe)", () => {
		expect(deriveIngestReadiness(undefined)).toEqual({ state: "empty" });
		expect(deriveIngestReadiness(null)).toEqual({ state: "empty" });
	});

	it("returns empty for an empty map (zero links)", () => {
		expect(deriveIngestReadiness({})).toEqual({ state: "empty" });
	});

	it("returns empty when a link is enabled but has no IP", () => {
		expect(deriveIngestReadiness({ eth0: entry(true) })).toEqual({
			state: "empty",
		});
	});

	it("returns empty when a link has an IP but is disabled", () => {
		expect(
			deriveIngestReadiness({ eth0: entry(false, "192.168.1.10") }),
		).toEqual({ state: "empty" });
	});

	it("returns links-ready with count 1 for a single enabled+IP'd link", () => {
		expect(
			deriveIngestReadiness({ eth0: entry(true, "192.168.1.10") }),
		).toEqual({ state: "links-ready", count: 1, ifaces: ["eth0"] });
	});

	it("returns links-ready with only the enabled+IP'd links counted (3 ready)", () => {
		const netif: NetifMessage = {
			eth0: entry(true, "192.168.1.10"),
			wwan0: entry(true, "10.0.0.2"),
			wwan1: entry(true, "10.0.1.2"),
			wwan2: entry(true), // enabled, no IP → not ready
			wlan0: entry(false, "192.168.2.5"), // has IP, disabled → not ready
		};
		const result = deriveIngestReadiness(netif);
		expect(result.state).toBe("links-ready");
		if (result.state === "links-ready") {
			expect(result.count).toBe(3);
			expect(result.ifaces).toEqual(["eth0", "wwan0", "wwan1"]);
		}
	});
});
