import type { ModemList, NetifEntry, NetifMessage } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import { buildBond, isBondExcluded, isBondMember } from "./link-status";

// Membership fields captured from the Rock's 2026-09-07 netif broadcast.
const twinEntry: NetifEntry = {
	tp: 0,
	enabled: true,
	ip: "192.168.8.100",
	error: "duplicate IPv4 addr",
};

describe("duplicate-IP bond eligibility from the device's wire projection", () => {
	it("admits a duplicate-IP link when the backend proves it bondable, before telemetry exists", () => {
		// Given the backend's enabled projection includes its mappability check.
		const entry = { ...twinEntry };
		// When the shared HUD membership rule reads that projection.
		const member = isBondMember(entry);
		// Then the source-address warning must not veto bond eligibility.
		expect(member).toBe(true);
		expect(isBondExcluded(entry)).toBe(false);
	});

	it("excludes a duplicate-IP link when the backend refuses it", () => {
		// All four causes project enabled:false, even with the same error text.
		const entry = { ...twinEntry, enabled: false };
		const member = isBondMember(entry);
		expect(member).toBe(false);
		expect(isBondExcluded(entry)).toBe(true);
	});

	it.each([
		"WiFi hotspot",
		"no SIM",
		"shared LAN",
		"unknown error",
		"duplicate IPv4 addr; no SIM",
	])("still excludes another error even when enabled is true: %s", (error) => {
		const entry = { ...twinEntry, error };
		const member = isBondMember(entry);
		expect(member).toBe(false);
		expect(isBondExcluded(entry)).toBe(true);
	});

	it("does not admit a duplicate-IP link without an address", () => {
		const entry = { ...twinEntry, ip: "" };
		const member = isBondMember(entry);
		expect(member).toBe(false);
	});
});

describe("buildBond keeps two same-address, same-model devices independent", () => {
	const modems: ModemList = {
		"1002": {
			ifname: "enx0c5b8f279a64",
			name: "Huawei E3372",
			network_type: { supported: [], active: null },
		},
		"1003": {
			ifname: "eth1",
			name: "Huawei E3372",
			network_type: { supported: [], active: null },
		},
	};
	const netif: NetifMessage = {
		enx0c5b8f279a64: twinEntry,
		eth1: { ...twinEntry, tp: 495, tx_bps: 792, rx_bps: 8924 },
	};

	it.each([undefined, modems])(
		"keeps both eligible interfaces with or without modem roster claims",
		(roster) => {
			const snapshot = buildBond(roster, undefined, netif, false, false, false);
			expect(snapshot.links.map(({ id }) => id)).toEqual([
				"enx0c5b8f279a64",
				"eth1",
			]);
			expect(snapshot.links.map(({ linkIndex }) => linkIndex)).toEqual([0, 1]);
			expect(snapshot.unbondedCount).toBe(0);
		},
	);

	it("counts only the refused twin, without dropping its eligible sibling", () => {
		const refused = { ...netif, eth1: { ...twinEntry, enabled: false } };
		const snapshot = buildBond(modems, undefined, refused, false, false, false);
		expect(snapshot.links.map(({ id }) => id)).toEqual(["enx0c5b8f279a64"]);
		expect(snapshot.unbondedCount).toBe(1);
	});

	it("retains idle eligibility without inventing stream throughput", () => {
		const snapshot = buildBond(
			modems,
			undefined,
			netif,
			false,
			false,
			false,
			new Set(),
			false,
		);
		expect(snapshot.links.map(({ throughputKbps }) => throughputKbps)).toEqual([
			0, 0,
		]);
		expect(snapshot.links[1]?.rateTxKbps).toBe(1);
	});
});
