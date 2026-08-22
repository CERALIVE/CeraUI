/**
 * The joined-client roster's render rule.
 *
 * The load-bearing case is the SIGNAL SCALE: a station's RSSI is dBm and the
 * app-wide `getSignalCategory` ramp is a 0-100 percent, so feeding one to the
 * other buckets a strong client as `weak`. The tier table below is what keeps
 * the two apart while still sharing one colour ramp.
 */
import type { HotspotConfig } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveHotspotClientsView,
	formatClientRatePair,
	hotspotClientSignalCategory,
} from "./hotspot-clients-view";

function hotspot(over: Partial<HotspotConfig> = {}): HotspotConfig {
	return {
		name: "CERALIVE_791c",
		available_channels: { auto: { name: "Automatic" } },
		...over,
	};
}

describe("hotspotClientSignalCategory — dBm tiers, not percent", () => {
	it.each([
		[-30, "excellent"],
		[-50, "excellent"],
		[-51, "good"],
		[-60, "good"],
		[-61, "fair"],
		[-70, "fair"],
		[-71, "weak"],
		[-95, "weak"],
	])("%i dBm is %s", (dbm, expected) => {
		expect(hotspotClientSignalCategory(dbm)).toBe(expected);
	});

	// The defect this exists to prevent: -47 dBm is a STRONG client, and the
	// percent ramp would call anything below 25 `weak`.
	it("does not bucket a strong client as weak", () => {
		expect(hotspotClientSignalCategory(-47)).toBe("excellent");
	});
});

describe("formatClientRatePair", () => {
	it("renders both directions when both were reported", () => {
		expect(formatClientRatePair(144.4, 130)).toBe("144 / 130");
	});

	// A bare `144 /` reads as a dropped value rather than an unreported one.
	it("renders ONE figure with no orphan separator", () => {
		expect(formatClientRatePair(144.4, undefined)).toBe("144");
		expect(formatClientRatePair(undefined, 130)).toBe("130");
	});

	it("omits the cell entirely when neither was reported", () => {
		expect(formatClientRatePair(undefined, undefined)).toBeUndefined();
	});
});

describe("deriveHotspotClientsView — three states, never two", () => {
	it("maps a populated roster to rows carrying signal, tier and rates", () => {
		const view = deriveHotspotClientsView(
			hotspot({
				clients: {
					count: 2,
					stations: [
						{
							mac: "8c:85:90:1a:2b:3c",
							signal_dbm: -47,
							tx_bitrate_mbps: 144.4,
							rx_bitrate_mbps: 130,
						},
						{ mac: "3c:22:fb:0e:91:7d", signal_dbm: -71 },
					],
				},
			}),
		);

		expect(view).toEqual({
			count: 2,
			capped: false,
			rows: [
				{
					mac: "8c:85:90:1a:2b:3c",
					signalDbm: -47,
					signalCategory: "excellent",
					txMbps: 144.4,
					rxMbps: 130,
				},
				{
					mac: "3c:22:fb:0e:91:7d",
					signalDbm: -71,
					signalCategory: "weak",
				},
			],
		});
	});

	// A MEASURED zero is a reading and must stay distinguishable from silence.
	it("keeps a measured zero as a roster, not as an absence", () => {
		expect(
			deriveHotspotClientsView(
				hotspot({ clients: { count: 0, stations: [] } }),
			),
		).toEqual({ count: 0, rows: [], capped: false });
	});

	// THE REGRESSION LOCK: an older backend sends no block at all.
	it("renders NOTHING when the device never reported a roster", () => {
		expect(deriveHotspotClientsView(hotspot())).toBeUndefined();
		expect(deriveHotspotClientsView(undefined)).toBeUndefined();
	});

	it("flags a capped roster so the count is never read as the row count", () => {
		const view = deriveHotspotClientsView(
			hotspot({
				clients: { count: 40, stations: [{ mac: "aa:bb:cc:dd:ee:01" }] },
			}),
		);
		expect(view?.count).toBe(40);
		expect(view?.rows).toHaveLength(1);
		expect(view?.capped).toBe(true);
	});

	// Colour never outlives its reading: no signal means no tier to paint with.
	it("emits no signal tier for a station that reported no signal", () => {
		const view = deriveHotspotClientsView(
			hotspot({
				clients: { count: 1, stations: [{ mac: "aa:bb:cc:dd:ee:01" }] },
			}),
		);
		expect(view?.rows[0]).toEqual({ mac: "aa:bb:cc:dd:ee:01" });
	});
});
