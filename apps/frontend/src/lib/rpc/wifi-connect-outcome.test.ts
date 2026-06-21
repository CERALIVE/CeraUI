/**
 * Unit tests for wifi-connect-outcome.ts
 *
 * Drives the pure {@link deriveWifiConnectOutcome} classifier directly — no
 * runes, no Svelte runtime. Covers the array-ack vs boolean-result split, the
 * new-network success/error frames, the secondary snapshot confirm, and the
 * pending fall-through.
 */

import { describe, expect, it } from "vitest";

import { deriveWifiConnectOutcome } from "./wifi-connect-outcome";

const DEVICE = "0";
const SSID = "HomeNet";

describe("deriveWifiConnectOutcome", () => {
	describe("saved-network connect (boolean result vs array ack)", () => {
		it("treats the array ack as pending (not a result)", () => {
			expect(
				deriveWifiConnectOutcome({ connect: ["uuid-1"] }, DEVICE, SSID, [
					{ ssid: SSID, active: false },
				]),
			).toBe("pending");
		});

		it("confirms on connect: true", () => {
			expect(
				deriveWifiConnectOutcome({ connect: true }, DEVICE, SSID, []),
			).toBe("confirmed");
		});

		it("fails on connect: false", () => {
			expect(
				deriveWifiConnectOutcome({ connect: false }, DEVICE, SSID, []),
			).toBe("failed");
		});

		it("prefers the boolean result over a stale snapshot", () => {
			// connect:false wins even though the snapshot still shows it active.
			expect(
				deriveWifiConnectOutcome({ connect: false }, DEVICE, SSID, [
					{ ssid: SSID, active: true },
				]),
			).toBe("failed");
		});
	});

	describe("new-network connect", () => {
		it("confirms on new.success", () => {
			expect(
				deriveWifiConnectOutcome({ new: { success: true } }, DEVICE, SSID, []),
			).toBe("confirmed");
		});

		it("fails on new.error (auth)", () => {
			expect(
				deriveWifiConnectOutcome({ new: { error: "auth" } }, DEVICE, SSID, []),
			).toBe("failed");
		});

		it("fails on new.error (generic)", () => {
			expect(
				deriveWifiConnectOutcome(
					{ new: { error: "generic" } },
					DEVICE,
					SSID,
					[],
				),
			).toBe("failed");
		});
	});

	describe("secondary snapshot confirm", () => {
		it("confirms when the target SSID is active in the snapshot", () => {
			expect(
				deriveWifiConnectOutcome({}, DEVICE, SSID, [
					{ ssid: "Other", active: false },
					{ ssid: SSID, active: true },
				]),
			).toBe("confirmed");
		});

		it("stays pending when the target SSID is present but not active", () => {
			expect(
				deriveWifiConnectOutcome({}, DEVICE, SSID, [
					{ ssid: SSID, active: false },
				]),
			).toBe("pending");
		});

		it("does not confirm when a different SSID is active", () => {
			expect(
				deriveWifiConnectOutcome({}, DEVICE, SSID, [
					{ ssid: "Other", active: true },
				]),
			).toBe("pending");
		});
	});

	describe("pending fall-through", () => {
		it("is pending for an empty frame with an empty snapshot", () => {
			expect(deriveWifiConnectOutcome({}, DEVICE, SSID, [])).toBe("pending");
		});
	});
});
