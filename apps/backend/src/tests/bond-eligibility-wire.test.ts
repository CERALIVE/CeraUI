import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	NETIF_DUPLICATE_IPV4_ERROR,
	netifEntrySchema,
} from "@ceraui/rpc/schemas";
import {
	getNetworkInterfaces,
	NETIF_ERR_DUPIPV4,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_NOSIM,
	NETIF_ERR_SHAREDLAN,
	netIfBuildMsg,
	resetBondOptOut,
	setBondOptOut,
} from "../modules/network/network-interfaces.ts";
import { setBondIdentityResolverForTest } from "../modules/streaming/bond-entry.ts";
import { genSrtlaBondEntries } from "../modules/streaming/srtla.ts";

const IFACE = "bond-wire0";

beforeEach(() => {
	resetBondOptOut();
	getNetworkInterfaces()[IFACE] = {
		ip: "192.168.8.100",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: false,
		error: NETIF_ERR_DUPIPV4,
	};
});

afterEach(() => {
	delete getNetworkInterfaces()[IFACE];
	setBondIdentityResolverForTest(null);
	resetBondOptOut();
});

describe("netif enabled is bond eligibility, not the internal enabled bit", () => {
	test("a mappable duplicate-IP row publishes enabled:true despite its internal false", () => {
		const entry = netifEntrySchema.parse(netIfBuildMsg()[IFACE]);
		expect(entry).toMatchObject({
			enabled: true,
			error: "duplicate IPv4 addr",
		});
		expect(entry.error).toBe(NETIF_DUPLICATE_IPV4_ERROR);
		expect(genSrtlaBondEntries().some(({ iface }) => iface === IFACE)).toBe(
			true,
		);
	});

	test("failed identity resolution publishes enabled:false with the same error text", () => {
		setBondIdentityResolverForTest(() => {
			throw new Error("unreadable descriptor");
		});
		const entry = netifEntrySchema.parse(netIfBuildMsg()[IFACE]);
		expect(entry).toMatchObject({
			enabled: false,
			error: "duplicate IPv4 addr",
		});
		expect(genSrtlaBondEntries().some(({ iface }) => iface === IFACE)).toBe(
			false,
		);
	});

	test("an operator opt-out publishes enabled:false for a mappable link", () => {
		setBondOptOut(IFACE, true);
		const entry = netifEntrySchema.parse(netIfBuildMsg()[IFACE]);
		expect(entry).toMatchObject({
			enabled: false,
			error: "duplicate IPv4 addr",
		});
		expect(genSrtlaBondEntries().some(({ iface }) => iface === IFACE)).toBe(
			false,
		);
	});

	test.each([NETIF_ERR_HOTSPOT, NETIF_ERR_NOSIM, NETIF_ERR_SHAREDLAN])(
		"a compound error (%i) stays refused even when serialization only names duplicate-IP",
		(otherError) => {
			const internal = getNetworkInterfaces()[IFACE];
			if (!internal) throw new Error("test interface missing");
			internal.error |= otherError;
			const entry = netifEntrySchema.parse(netIfBuildMsg()[IFACE]);
			expect(entry).toMatchObject({
				enabled: false,
				error: "duplicate IPv4 addr",
			});
			expect(genSrtlaBondEntries().some(({ iface }) => iface === IFACE)).toBe(
				false,
			);
		},
	);
});
