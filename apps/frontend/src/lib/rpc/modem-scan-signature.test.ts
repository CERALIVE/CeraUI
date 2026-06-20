/**
 * Unit tests for modem-scan-signature.ts
 *
 * The signature is the scan-confirm signal: a modem operator scan is confirmed
 * only when the visible-operator set genuinely changes. These cases lock the two
 * contracts that matter — a content change (a new/removed operator, or an
 * availability flip) moves the hash, and the mere RE-PRESENCE of the same set on
 * a periodic full-state broadcast does NOT (it would otherwise false-confirm
 * every tick).
 */

import { describe, expect, it } from "vitest";

import {
	type ModemScanSignatureNetwork,
	modemScanSignature,
} from "./modem-scan-signature";

const net = (
	overrides: Partial<ModemScanSignatureNetwork> = {},
): ModemScanSignatureNetwork => ({
	name: "Operator",
	availability: "available",
	...overrides,
});

describe("modemScanSignature", () => {
	it("hashes an empty/absent set to the empty string", () => {
		expect(modemScanSignature(undefined)).toBe("");
		expect(modemScanSignature({})).toBe("");
	});

	it("hashes the same operator set to the same value regardless of key order", () => {
		const a = {
			"26201": net({ name: "Telekom" }),
			"26202": net({ name: "Vodafone" }),
			"26203": net({ name: "O2" }),
		};
		const b = {
			"26203": net({ name: "O2" }),
			"26201": net({ name: "Telekom" }),
			"26202": net({ name: "Vodafone" }),
		};
		expect(modemScanSignature(a)).toBe(modemScanSignature(b));
	});

	it("does NOT change when the identical set is re-broadcast (presence alone must not confirm)", () => {
		const before = { "26201": net({ name: "Telekom" }) };
		const reBroadcast = { "26201": net({ name: "Telekom" }) };
		expect(modemScanSignature(reBroadcast)).toBe(modemScanSignature(before));
	});

	it("changes the hash when an operator is added", () => {
		const before = { "26201": net({ name: "Telekom" }) };
		const after = {
			"26201": net({ name: "Telekom" }),
			"26202": net({ name: "Vodafone" }),
		};
		expect(modemScanSignature(after)).not.toBe(modemScanSignature(before));
	});

	it("changes the hash when an operator is removed", () => {
		const before = {
			"26201": net({ name: "Telekom" }),
			"26202": net({ name: "Vodafone" }),
		};
		const after = { "26201": net({ name: "Telekom" }) };
		expect(modemScanSignature(after)).not.toBe(modemScanSignature(before));
	});

	it("changes the hash when an operator's availability flips", () => {
		const before = { "26201": net({ availability: "available" }) };
		const after = { "26201": net({ availability: "unavailable" }) };
		expect(modemScanSignature(after)).not.toBe(modemScanSignature(before));
	});
});
