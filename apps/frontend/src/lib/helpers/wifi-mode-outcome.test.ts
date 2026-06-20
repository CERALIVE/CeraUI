/**
 * Unit tests for wifi-mode-outcome.ts
 *
 * Locks the station⇆hotspot mode-switch confirm truth table the WifiSection
 * `$effect` relies on: only the matching (target, snapshot) pair confirms; every
 * mismatch and the no-switch case stay pending so a periodic `wifi` re-broadcast
 * can never clobber a mid-switch label.
 */

import { describe, expect, it } from "vitest";

import { deriveWifiModeOutcome } from "./wifi-mode-outcome";

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
