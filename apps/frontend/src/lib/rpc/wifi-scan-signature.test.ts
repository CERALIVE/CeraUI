/**
 * Unit tests for wifi-scan-signature.ts
 *
 * The signature is the scan-confirm signal: a manual WiFi scan is confirmed only
 * when the visible-AP set genuinely changes. These cases lock the two contracts
 * that matter — a content change (add/remove/security/band) moves the hash, and a
 * volatile `signal`-only change does NOT (it would otherwise false-confirm every
 * periodic re-broadcast).
 */

import { describe, expect, it } from "vitest";

import {
	type WifiScanSignatureNetwork,
	wifiScanSignature,
} from "./wifi-scan-signature";

const net = (
	ssid: string,
	overrides: Partial<WifiScanSignatureNetwork> = {},
): WifiScanSignatureNetwork & { signal: number } => ({
	ssid,
	security: "WPA2",
	freq: 2412,
	signal: 70,
	...overrides,
});

describe("wifiScanSignature", () => {
	it("hashes the same set to the same value regardless of order", () => {
		const a = [net("alpha"), net("bravo"), net("charlie")];
		const b = [net("charlie"), net("alpha"), net("bravo")];
		expect(wifiScanSignature(a)).toBe(wifiScanSignature(b));
	});

	it("changes the hash when an AP is added", () => {
		const before = [net("alpha"), net("bravo")];
		const after = [net("alpha"), net("bravo"), net("charlie")];
		expect(wifiScanSignature(after)).not.toBe(wifiScanSignature(before));
	});

	it("changes the hash when an AP is removed", () => {
		const before = [net("alpha"), net("bravo"), net("charlie")];
		const after = [net("alpha"), net("charlie")];
		expect(wifiScanSignature(after)).not.toBe(wifiScanSignature(before));
	});

	it("does NOT change the hash on a signal-only fluctuation", () => {
		const before = [net("alpha", { signal: 40 }), net("bravo", { signal: 80 })];
		const after = [net("alpha", { signal: 90 }), net("bravo", { signal: 12 })];
		expect(wifiScanSignature(after)).toBe(wifiScanSignature(before));
	});

	it("changes the hash when security or band changes", () => {
		const base = [net("alpha")];
		expect(wifiScanSignature([net("alpha", { security: "WPA3" })])).not.toBe(
			wifiScanSignature(base),
		);
		expect(wifiScanSignature([net("alpha", { freq: 5180 })])).not.toBe(
			wifiScanSignature(base),
		);
	});

	it("hashes an empty set to a stable empty string", () => {
		expect(wifiScanSignature([])).toBe("");
		expect(wifiScanSignature([])).toBe(wifiScanSignature([]));
	});
});
