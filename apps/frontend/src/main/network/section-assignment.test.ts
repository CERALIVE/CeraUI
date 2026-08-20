/**
 * Section ownership on the Network destination (todo 53).
 *
 * The operator's report was blunt: "everything should be in modems, not in
 * Ethernet." The relocation is only correct if every interface lands in exactly
 * ONE section — a device in neither has silently vanished, and a device in both
 * has two bond toggles that can contradict each other.
 *
 * The rows below are the real bench topology: a ZTE MF79U-class unit bonded on
 * its own subnet, and a Huawei HiLink pair sharing one factory MAC, which is why
 * one is `enx0c5b8f279a64` and its twin fell back to `eth1`.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { isWiredSectionEntry, modemClaimedIfnames } from "./section-assignment";

const HILINK_MARKER = {
	vendor: "Huawei",
	model: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
	vid_pid: "12d1:14dc",
	kind: "router-cellular",
	duplicate_model: true,
} as const;

const ZTE_MARKER = {
	vendor: "ZTE",
	model: "ZTE Mobile Boardband",
	vid_pid: "19d2:1405",
	kind: "router-cellular",
	duplicate_model: false,
} as const;

const FM350_MARKER = {
	vendor: "Fibocom Wireless Inc.",
	model: "FM350-GL",
	vid_pid: "0e8d:7127",
	kind: "modem-net",
} as const;

const BENCH: Record<string, NetifEntry> = {
	eth0: { tp: 5, enabled: true, ip: "192.168.78.132" },
	enx344b50000000: {
		tp: 12,
		enabled: true,
		ip: "192.168.0.169",
		router_cellular: ZTE_MARKER,
	},
	enx0c5b8f279a64: {
		tp: 0,
		enabled: false,
		ip: "192.168.8.100",
		router_cellular: HILINK_MARKER,
	},
	eth1: {
		tp: 0,
		enabled: false,
		ip: "192.168.8.100",
		router_cellular: HILINK_MARKER,
	},
	wlan0: { tp: 0, enabled: false },
	wwan0: { tp: 0, enabled: false },
	lo: { tp: 0, enabled: false, ip: "127.0.0.1" },
	// Todo 66: the bench Fibocom FM350-GL's RNDIS data function. ModemManager
	// names this very interface as the modem's net port, so its Cellular row
	// claims it — but its `enx…` name is MAC-derived, so no prefix can reach it.
	enx000011121314: {
		tp: 0,
		enabled: false,
		usb_modem_net: FM350_MARKER,
	},
};

function wiredNames(claimed: ReadonlySet<string>): string[] {
	return Object.entries(BENCH)
		.filter(([name, iface]) => isWiredSectionEntry(name, iface, claimed))
		.map(([name]) => name);
}

const ALL_THREE_CLAIMED = modemClaimedIfnames([
	["1000", { ifname: "enx344b50000000" }],
	["1001", { ifname: "enx0c5b8f279a64" }],
	["1002", { ifname: "eth1" }],
	["2", { ifname: "wwan0" }],
	["4", { ifname: "enx000011121314" }],
]);

describe("router dongles move to Cellular once a modem row claims them", () => {
	it("leaves only the real NIC in the Ethernet section", () => {
		expect(wiredNames(ALL_THREE_CLAIMED)).toEqual(["eth0"]);
	});

	it("moves all THREE bench dongles, including the duplicate-MAC twin", () => {
		const wired = wiredNames(ALL_THREE_CLAIMED);
		for (const dongle of ["enx344b50000000", "enx0c5b8f279a64", "eth1"]) {
			expect(wired).not.toContain(dongle);
		}
	});

	it("moves a dongle even while it is an active bond member", () => {
		expect(BENCH.enx344b50000000?.enabled).toBe(true);
		expect(wiredNames(ALL_THREE_CLAIMED)).not.toContain("enx344b50000000");
	});
});

describe("no interface may fall between the two sections", () => {
	// The handover window: the classifier marker rides `netif`, the row rides
	// `modems`, and the two are independent broadcasts. Dropping the row on the
	// marker alone hides the device until the roster catches up.
	it("keeps an unclaimed dongle in Ethernet rather than nowhere", () => {
		const wired = wiredNames(new Set<string>());

		expect(wired).toContain("enx344b50000000");
		expect(wired).toContain("enx0c5b8f279a64");
		expect(wired).toContain("eth1");
	});

	it("moves only the claimed twin while the other waits for its row", () => {
		const wired = wiredNames(new Set(["enx0c5b8f279a64"]));

		expect(wired).not.toContain("enx0c5b8f279a64");
		expect(wired).toContain("eth1");
	});
});

describe("the pre-existing prefix rules are untouched", () => {
	it("never claims a modem, a wifi radio or loopback for Ethernet", () => {
		const wired = wiredNames(ALL_THREE_CLAIMED);

		expect(wired).not.toContain("wwan0");
		expect(wired).not.toContain("wlan0");
		expect(wired).not.toContain("lo");
	});

	it("keeps a plain NIC even when a modem row names it", () => {
		expect(wiredNames(new Set(["eth0"]))).toContain("eth0");
	});
});

/*
 * Todo 66. The FM350-GL is fully represented as a modem, and its RNDIS data
 * function ALSO enumerated as its own bare Ethernet row — the same physical
 * device rendered twice, the second time as an unexplained adapter.
 */
describe("an MM-managed modem's own data function is not a second device", () => {
	it("moves the FM350's RNDIS interface out of Ethernet once its row claims it", () => {
		expect(wiredNames(ALL_THREE_CLAIMED)).not.toContain("enx000011121314");
	});

	it("keeps it in Ethernet until that row exists, so it can never vanish", () => {
		expect(wiredNames(new Set<string>())).toContain("enx000011121314");
	});

	// The marker is what makes the claim safe to act on: without it a modem row
	// naming an ordinary NIC could take the board's management link off the list.
	it("still refuses to move an unmarked interface a modem row names", () => {
		expect(wiredNames(new Set(["eth0", "enx000011121314"]))).toContain("eth0");
	});
});
