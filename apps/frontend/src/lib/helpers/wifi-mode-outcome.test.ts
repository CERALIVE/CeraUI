/**
 * Unit tests for wifi-mode-outcome.ts
 *
 * Locks the station⇆hotspot mode-switch confirm truth table the WifiSection
 * `$effect` relies on: only the matching (target, snapshot) pair confirms; every
 * mismatch and the no-switch case stay pending so a periodic `wifi` re-broadcast
 * can never clobber a mid-switch label.
 */

import { describe, expect, it } from "vitest";

import { deriveWifiModeOutcome, isApRadio } from "./wifi-mode-outcome";

describe("deriveWifiModeOutcome", () => {
	it("confirms a hotspot switch once the snapshot reports hotspot mode", () => {
		expect(deriveWifiModeOutcome("hotspot", true)).toBe("confirmed");
	});

	it("stays pending for a hotspot switch while the snapshot still reports station", () => {
		expect(deriveWifiModeOutcome("hotspot", false)).toBe("pending");
	});

	it("confirms a station switch once the snapshot reports station mode", () => {
		expect(deriveWifiModeOutcome("station", false)).toBe("confirmed");
	});

	it("stays pending for a station switch while the snapshot still reports hotspot", () => {
		expect(deriveWifiModeOutcome("station", true)).toBe("pending");
	});

	it("is always pending when no switch is in flight (target undefined)", () => {
		expect(deriveWifiModeOutcome(undefined, true)).toBe("pending");
		expect(deriveWifiModeOutcome(undefined, false)).toBe("pending");
	});
});

describe("isApRadio", () => {
	it("classifies a radio the backend reports as hotspot mode as an access point", () => {
		expect(isApRadio({ mode: "hotspot" })).toBe(true);
	});

	it("classifies an AP-mode radio whose hotspot profile is not yet adopted", () => {
		// The live regression: `hotspot` is still absent while the profile is being
		// discovered, but `mode` already says the radio is broadcasting. Reading
		// `hotspot` alone rendered it as a client connection with Connect/In Bond.
		expect(isApRadio({ mode: "hotspot", hotspot: undefined })).toBe(true);
	});

	it("classifies a station-mode radio as a client, even with an active connection", () => {
		expect(isApRadio({ mode: "station" })).toBe(false);
	});

	it("falls back to the hotspot payload when the backend reports no mode", () => {
		expect(isApRadio({ hotspot: { available_channels: {} } })).toBe(true);
		expect(isApRadio({})).toBe(false);
	});
});
