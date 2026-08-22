/**
 * What the hotspot dialog may OFFER, derived from the device's offered map.
 *
 * The three states are genuinely three and the tests keep them apart:
 * ABSENT (an older backend — render nothing, the regression lock), ONE offered
 * mode (state it, because one option is not a choice), and TWO (a real
 * selector). Collapsing the first two would put an "unavailable" apology on
 * every device running a backend that predates todo 8.
 */
import type {
	HotspotConfig,
	WifiAdapterCapabilities,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveHotspotRadioTruth,
	deriveHotspotSecurityChoice,
	selectableHotspotSecurity,
} from "./hotspot-options";

const WPA2_ONLY = { wpa2: { name: "WPA2 (Personal)" } };
const BOTH = {
	wpa2: { name: "WPA2 (Personal)" },
	"wpa3-sae": { name: "WPA3 (SAE)" },
};

function hotspot(over: Partial<HotspotConfig> = {}): HotspotConfig {
	return {
		name: "CERALIVE_791c",
		password: "correcthorse",
		available_channels: { auto: { name: "Automatic" } },
		channel: "auto",
		...over,
	};
}

function caps(
	over: Partial<WifiAdapterCapabilities> = {},
): WifiAdapterCapabilities {
	return {
		phy: "phy0",
		generation: "wifi6",
		bands: ["2.4", "5"],
		maxWidthMhz: { "2.4": 40, "5": 80 },
		apModes: ["2.4", "5"],
		staApCombo: { supported: true, sameChannelOnly: true },
		wpa3Sae: "supported",
		regulatory: { country: "ES", is6GhzLegal: false, self_managed: false },
		...over,
	};
}

describe("deriveHotspotSecurityChoice", () => {
	it("offers a real selector when the device derived TWO modes", () => {
		const choice = deriveHotspotSecurityChoice(
			hotspot({ available_security: BOTH, security: "wpa3-sae" }),
		);
		expect(choice).toEqual({
			kind: "select",
			options: [
				{ id: "wpa2", name: "WPA2 (Personal)" },
				{ id: "wpa3-sae", name: "WPA3 (SAE)" },
			],
			selected: "wpa3-sae",
		});
	});

	// One option is not a choice: a single-item radiogroup is a control that
	// cannot change anything, which is exactly the shipped fleet's state.
	it("STATES a single offered mode instead of offering a control", () => {
		const choice = deriveHotspotSecurityChoice(
			hotspot({ available_security: WPA2_ONLY }),
		);
		expect(choice).toEqual({
			kind: "stated",
			option: { id: "wpa2", name: "WPA2 (Personal)" },
		});
		expect(selectableHotspotSecurity(choice)).toBeUndefined();
	});

	// THE REGRESSION LOCK: absent is not empty.
	it("renders NOTHING when the device reported no offering at all", () => {
		expect(deriveHotspotSecurityChoice(hotspot())).toBeUndefined();
		expect(deriveHotspotSecurityChoice(undefined)).toBeUndefined();
	});

	it("renders nothing for an offering that named no mode (drift, not empty)", () => {
		expect(
			deriveHotspotSecurityChoice(hotspot({ available_security: {} })),
		).toBeUndefined();
	});

	// CT-1 / CT-4: a mode the radio's capability read did not prove is not a
	// disabled row — it is no row. A disabled control would claim a capability
	// is being withheld when the hardware simply lacks it.
	it("emits NO option for a mode absent from the offered map", () => {
		const choice = deriveHotspotSecurityChoice(
			hotspot({ available_security: WPA2_ONLY }),
		);
		const ids =
			choice?.kind === "select" ? choice.options.map((o) => o.id) : ["wpa2"];
		expect(ids).not.toContain("wpa3-sae");
	});

	it("opens on WPA2 when the configured mode is not in the offering", () => {
		const choice = deriveHotspotSecurityChoice(
			hotspot({ available_security: BOTH, security: undefined }),
		);
		expect(selectableHotspotSecurity(choice)).toBe("wpa2");
	});

	it("orders the modes weakest-first, never in wire order", () => {
		const reversed = {
			"wpa3-sae": { name: "WPA3 (SAE)" },
			wpa2: { name: "WPA2 (Personal)" },
		};
		const choice = deriveHotspotSecurityChoice(
			hotspot({ available_security: reversed }),
		);
		expect(
			choice?.kind === "select" && choice.options.map((o) => o.id),
		).toEqual(["wpa2", "wpa3-sae"]);
	});
});

describe("deriveHotspotRadioTruth", () => {
	it("states the width per hotspot-eligible band plus the generation", () => {
		expect(
			deriveHotspotRadioTruth(
				hotspot({ max_width_mhz: { "2.4": 40, "5": 80 } }),
				caps(),
			),
		).toEqual({
			generationLabelKey: "network.wifiCapability.generation.wifi6",
			bands: [
				{
					band: "2.4",
					labelKey: "network.wifiCapability.band24",
					widthMhz: 40,
				},
				{ band: "5", labelKey: "network.wifiCapability.band5", widthMhz: 80 },
			],
		});
	});

	it("omits a band the device reported no width for", () => {
		const truth = deriveHotspotRadioTruth(
			hotspot({ max_width_mhz: { "2.4": 20 } }),
			caps(),
		);
		expect(truth?.bands.map((b) => b.band)).toEqual(["2.4"]);
	});

	// A 6 GHz-capable radio still gets no 6 GHz entry: `802-11-wireless.band` has
	// no value for it, so the wire type carries no such key at all.
	it("cannot express a 6 GHz hotspot width, however capable the radio", () => {
		const truth = deriveHotspotRadioTruth(
			hotspot({ max_width_mhz: { "2.4": 40, "5": 160 } }),
			caps({ generation: "wifi7", bands: ["2.4", "5", "6"] }),
		);
		expect(truth?.bands.map((b) => b.band)).toEqual(["2.4", "5"]);
	});

	it("still states the generation when no width was reported", () => {
		const truth = deriveHotspotRadioTruth(hotspot(), caps());
		expect(truth).toEqual({
			generationLabelKey: "network.wifiCapability.generation.wifi6",
			bands: [],
		});
	});

	it("still states the widths when no capability block was reported", () => {
		const truth = deriveHotspotRadioTruth(
			hotspot({ max_width_mhz: { "5": 80 } }),
			undefined,
		);
		expect(truth?.generationLabelKey).toBeUndefined();
		expect(truth?.bands).toHaveLength(1);
	});

	// THE REGRESSION LOCK: nothing measured means no line, never a placeholder.
	it("renders NOTHING when the device reported neither", () => {
		expect(deriveHotspotRadioTruth(hotspot(), undefined)).toBeUndefined();
		expect(deriveHotspotRadioTruth(undefined, undefined)).toBeUndefined();
	});

	it("ignores a non-positive width rather than stating a measured zero", () => {
		expect(
			deriveHotspotRadioTruth(
				hotspot({ max_width_mhz: { "2.4": 0 } as never }),
				undefined,
			),
		).toBeUndefined();
	});
});
