/**
 * The Wi-Fi capability render rule, over the boards this fleet actually ships.
 *
 * The two board fixtures are the shapes todo 2's backend suite parsed out of
 * VERBATIM `iw phy` / `iw reg get` captures — the Rock 5B+'s RTL8852BE and an
 * MT7925-class EHT radio — so a change that makes this module disagree with the
 * device's own parser fails here rather than on a board.
 */
import type { WifiAdapterCapabilities } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	blockIsOperatorActionable,
	CAPABILITY_BAND_ORDER,
	deriveWifiCapabilityView,
	wpa3ChipKey,
} from "./wifi-capability-view";

/**
 * Rock 5B+ / Realtek RTL8852BE, read verbatim. HE on both bands and NO Band 4,
 * so Wi-Fi 6 and never 6E; VHT says "neither 160 nor 80+80" and HE says HE80, so
 * 80 MHz is the widest thing it claimed on 5 GHz.
 */
const ROCK_RTL8852BE: WifiAdapterCapabilities = {
	phy: "phy0",
	generation: "wifi6",
	bands: ["2.4", "5"],
	maxWidthMhz: { "2.4": 40, "5": 80 },
	apModes: ["2.4", "5"],
	staApCombo: { supported: true, sameChannelOnly: true },
	wpa3Sae: "supported",
	regulatory: { country: "00", is6GhzLegal: false, self_managed: false },
};

/** MT7925-class: EHT with non-zero structures, a 6 GHz band, self-managed domain. */
const MT7925: WifiAdapterCapabilities = {
	phy: "phy0",
	generation: "wifi7",
	bands: ["2.4", "5", "6"],
	maxWidthMhz: { "2.4": 40, "5": 160, "6": 320 },
	apModes: ["2.4", "5", "6"],
	staApCombo: { supported: true, sameChannelOnly: false },
	wpa3Sae: "supported",
	regulatory: { country: "US", is6GhzLegal: true, self_managed: true },
};

function withRegulatory(
	base: WifiAdapterCapabilities,
	regulatory: Partial<WifiAdapterCapabilities["regulatory"]>,
): WifiAdapterCapabilities {
	return { ...base, regulatory: { ...base.regulatory, ...regulatory } };
}

describe("deriveWifiCapabilityView — absence is the regression lock", () => {
	it("derives NOTHING when the device computed no capability report", () => {
		expect(deriveWifiCapabilityView(undefined)).toBeUndefined();
	});
});

describe("deriveWifiCapabilityView — the shipped RTL8852BE", () => {
	it("offers exactly the two bands the radio carries, with their own widths", () => {
		const view = deriveWifiCapabilityView(ROCK_RTL8852BE);

		expect(view?.bands).toEqual([
			{
				band: "2.4",
				labelKey: "network.wifiCapability.band24",
				available: true,
				maxWidthMhz: 40,
			},
			{
				band: "5",
				labelKey: "network.wifiCapability.band5",
				available: true,
				maxWidthMhz: 80,
			},
		]);
	});

	it("contributes ZERO 6 GHz entries — the radio positively lacks the band", () => {
		const view = deriveWifiCapabilityView(ROCK_RTL8852BE);

		expect(view?.bands.some((b) => b.band === "6")).toBe(false);
		// And no reason either: pointing at the country dialog would blame a
		// regulatory domain for hardware that has no 6 GHz radio in it.
		expect(view?.blockedBands).toEqual([]);
	});

	it("takes the generation from the wire, never from the EHT structures", () => {
		expect(deriveWifiCapabilityView(ROCK_RTL8852BE)?.generation).toBe("wifi6");
		expect(deriveWifiCapabilityView(ROCK_RTL8852BE)?.generationLabelKey).toBe(
			"network.wifiCapability.generation.wifi6",
		);
	});

	it("reports STA+AP as same-channel only, which is what `#channels <= 1` means", () => {
		expect(deriveWifiCapabilityView(ROCK_RTL8852BE)?.comboNoteKey).toBe(
			"network.wifiCapability.combo.sameChannel",
		);
	});

	it("carries the observed world domain rather than a requested country", () => {
		const view = deriveWifiCapabilityView(ROCK_RTL8852BE);
		expect(view?.country).toBe("00");
		expect(view?.countryIsWorld).toBe(true);
		expect(view?.selfManagedRegulatory).toBe(false);
	});
});

describe("deriveWifiCapabilityView — an MT7925-class Wi-Fi 7 radio", () => {
	it("offers all three bands, 6 GHz included, when the domain permits it", () => {
		const view = deriveWifiCapabilityView(MT7925);

		expect(view?.generation).toBe("wifi7");
		expect(view?.bands.map((b) => b.band)).toEqual(["2.4", "5", "6"]);
		expect(view?.bands.every((b) => b.available)).toBe(true);
		expect(view?.blockedBands).toEqual([]);
		expect(view?.bands.at(-1)?.maxWidthMhz).toBe(320);
	});

	it("reports STA+AP on independent channels when `#channels` allows two", () => {
		expect(deriveWifiCapabilityView(MT7925)?.comboNoteKey).toBe(
			"network.wifiCapability.combo.anyChannel",
		);
	});
});

describe("deriveWifiCapabilityView — a carried band the domain forbids", () => {
	it("keeps 6 GHz listed and marks it blocked by the regulatory domain", () => {
		const view = deriveWifiCapabilityView(
			withRegulatory(MT7925, {
				country: "CO",
				is6GhzLegal: false,
				self_managed: false,
			}),
		);

		const six = view?.bands.find((b) => b.band === "6");
		expect(six, "a band the radio carries must never be hidden").toBeDefined();
		expect(six?.available).toBe(false);
		expect(six?.blockedBy).toBe("regulatory-domain");
		expect(view?.blockedBands).toEqual([six]);
		// The width the radio advertised is still true, and still shown.
		expect(six?.maxWidthMhz).toBe(320);
	});

	it("blames the FIRMWARE, not the country, on a self-managed wiphy", () => {
		const view = deriveWifiCapabilityView(
			withRegulatory(MT7925, { is6GhzLegal: false, self_managed: true }),
		);

		expect(view?.bands.find((b) => b.band === "6")?.blockedBy).toBe(
			"self-managed",
		);
	});

	it("never blocks 2.4 or 5 GHz — the wire has no legality flag for them", () => {
		const view = deriveWifiCapabilityView(
			withRegulatory(MT7925, { is6GhzLegal: false, self_managed: false }),
		);

		expect(
			view?.bands.filter((b) => b.band !== "6").every((b) => b.available),
		).toBe(true);
	});

	it("offers the country action for a domain block and withholds it otherwise", () => {
		const domain = deriveWifiCapabilityView(
			withRegulatory(MT7925, { is6GhzLegal: false, self_managed: false }),
		)?.blockedBands[0];
		const firmware = deriveWifiCapabilityView(
			withRegulatory(MT7925, { is6GhzLegal: false, self_managed: true }),
		)?.blockedBands[0];

		expect(domain && blockIsOperatorActionable(domain)).toBe(true);
		// A self-managed wiphy carries its own rules: the country dialog cannot
		// move it, so a "Set country" button there would be a control that
		// provably cannot act.
		expect(firmware && blockIsOperatorActionable(firmware)).toBe(false);
	});
});

describe("deriveWifiCapabilityView — degradation subtracts, never invents", () => {
	it("omits a width the kernel did not report for a band it does carry", () => {
		const view = deriveWifiCapabilityView({
			...ROCK_RTL8852BE,
			maxWidthMhz: { "2.4": 40 },
		});

		expect(view?.bands.map((b) => b.maxWidthMhz)).toEqual([40, undefined]);
	});

	it("drops the STA+AP note entirely when the combo is unsupported", () => {
		const view = deriveWifiCapabilityView({
			...ROCK_RTL8852BE,
			staApCombo: { supported: false, sameChannelOnly: false },
		});

		expect(view?.comboNoteKey).toBeUndefined();
		expect(Object.hasOwn(view ?? {}, "comboNoteKey")).toBe(false);
	});

	it("reports a single-band radio as a single band", () => {
		const view = deriveWifiCapabilityView({
			...ROCK_RTL8852BE,
			generation: "wifi4",
			bands: ["2.4"],
			maxWidthMhz: { "2.4": 20 },
		});

		expect(view?.bands.map((b) => b.band)).toEqual(["2.4"]);
		expect(view?.generationLabelKey).toBe(
			"network.wifiCapability.generation.wifi4",
		);
	});

	it("orders bands by frequency regardless of the order on the wire", () => {
		const view = deriveWifiCapabilityView({
			...MT7925,
			bands: ["6", "2.4", "5"],
		});

		expect(view?.bands.map((b) => b.band)).toEqual([...CAPABILITY_BAND_ORDER]);
	});
});

describe("wpa3ChipKey — unknown is a first-class answer", () => {
	it("renders the positive capability", () => {
		expect(wpa3ChipKey("supported")).toBe(
			"network.wifiCapability.wpa3.supported",
		);
	});

	it("renders `unknown` as its own thing, never as unsupported", () => {
		expect(wpa3ChipKey("unknown")).toBe("network.wifiCapability.wpa3.unknown");
		expect(wpa3ChipKey("unknown")).not.toBe(wpa3ChipKey("supported"));
	});

	it("draws nothing for a radio that positively cannot do WPA3", () => {
		expect(wpa3ChipKey("unsupported")).toBeUndefined();
	});
});
