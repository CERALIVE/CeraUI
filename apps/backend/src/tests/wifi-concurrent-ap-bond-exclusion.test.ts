/**
 * THE CONCURRENT-AP NETDEV MUST NEVER REACH `genSrtlaIpList()`.
 *
 * This case had NO coverage, and the reason is the same shape as the SIM-less
 * dongle's: every existing hotspot bond test reasons about the PHYSICAL radio,
 * whose AP mode is flagged by walking the WiFi registry for `isApMode` adapters.
 * A hybrid radio's parent is truthfully a STATION, so that walk never reaches
 * the virtual `clap-<parent>` netdev the access point actually runs on — and
 * NetworkManager's shared mode leases that netdev `10.42.0.1`, a routable
 * address on a RUNNING, enabled, error-free interface. Every property
 * `isBondCandidate` reads said "bond me".
 *
 * The suite drives the REAL `processIfconfigOutput` and the REAL
 * `genSrtlaIpList`, because the defect lives in the WIRING: a test aimed at the
 * pure predicate alone passes on a tree where nothing ever stamps the flag.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
	applyConcurrentApBondGate,
	getNetifErrorMsg,
	getNetworkInterfaces,
	isBondCandidate,
	NETIF_ERR_HOTSPOT,
	type NetworkInterface,
	netIfBuildMsg,
	processIfconfigOutput,
	resetBondOptOut,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import { resetPolicyRouteFlags } from "../modules/network/policy-route-check.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import { genSrtlaIpList } from "../modules/streaming/srtla.ts";

const CONCURRENT_AP = "clap-wlan0";
const AP_ADDRESS = "10.42.0.1";

function ifconfigStanza(name: string, ip: string, mac: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast ${ip.replace(/\.\d+$/, ".255")}`,
		`        ether ${mac}  txqueuelen 1000  (Ethernet)`,
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

function ifconfig(...stanzas: string[]): string {
	return stanzas.join("\n\n");
}

/**
 * A hybrid radio as the kernel really presents it: the parent still holds its
 * station lease, and the access point runs on a second netdev beside it.
 */
function hybridTopology(): string {
	return ifconfig(
		ifconfigStanza("eth0", "192.168.78.132", "aa:bb:cc:dd:ee:01"),
		ifconfigStanza("wlan0", "192.168.1.50", "aa:bb:cc:dd:ee:02"),
		ifconfigStanza(CONCURRENT_AP, AP_ADDRESS, "aa:bb:cc:dd:ee:03"),
	);
}

function iface(over: Partial<NetworkInterface> = {}): NetworkInterface {
	return {
		ip: AP_ADDRESS,
		netmask: "255.255.255.0",
		txb: 0,
		rxb: 0,
		tp: 0,
		enabled: true,
		error: 0,
		...over,
	} as NetworkInterface;
}

beforeEach(() => {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const name of [CONCURRENT_AP, "wlan0", "eth0"]) {
		setNetifDupIpSuppression(name, false);
	}
	resetBondOptOut();
	resetPolicyRouteFlags();
	setQueueUpdateGwHook(null);
});

describe("a concurrent AP holding 10.42.0.1 never enters the bond", () => {
	test("`genSrtlaIpList` emits no 10.42.0.x while the AP is up", () => {
		processIfconfigOutput(hybridTopology());

		const bonded = genSrtlaIpList();

		expect(bonded).not.toContain(AP_ADDRESS);
		for (const ip of bonded) {
			expect(ip.startsWith("10.42.0.")).toBe(false);
		}
		// Non-vacuity: the station leg and the wired uplink DID bond, so the list
		// is not empty for some unrelated reason.
		expect(bonded.sort()).toEqual(["192.168.1.50", "192.168.78.132"]);
	});

	test("`isBondCandidate` refuses it structurally, even error-free", () => {
		// A hand-built entry with every property that normally says "bond me".
		expect(isBondCandidate(CONCURRENT_AP, iface())).toBe(false);
		// Non-vacuity: the identical entry under an ordinary name IS a candidate.
		expect(isBondCandidate("wlan0", iface())).toBe(true);
	});

	test("it carries the hotspot exclusion in the netif map, not just in a filter", () => {
		processIfconfigOutput(hybridTopology());

		const entry = getNetworkInterfaces()[CONCURRENT_AP];
		expect(entry).toBeDefined();
		expect((entry?.error ?? 0) & NETIF_ERR_HOTSPOT).toBe(NETIF_ERR_HOTSPOT);
		expect(entry?.enabled).toBe(false);
		// The flag is what the wire, the probe-eligibility rule and the
		// same-subnet grouping all already read, so they inherit the exclusion
		// rather than each learning a second rule.
		expect(getNetifErrorMsg(entry as NetworkInterface)).toBe("WiFi hotspot");
		expect(netIfBuildMsg()[CONCURRENT_AP]?.error).toBe("WiFi hotspot");
	});

	test("the parent station is untouched — a hybrid radio still bonds", () => {
		processIfconfigOutput(hybridTopology());

		const parent = getNetworkInterfaces().wlan0;
		expect(parent?.error).toBe(0);
		expect(parent?.enabled).toBe(true);
		expect(isBondCandidate("wlan0", parent as NetworkInterface)).toBe(true);
	});

	test("the gate re-applies on a pass where NOTHING about the topology moved", () => {
		processIfconfigOutput(hybridTopology());
		// Clearing the flag by hand models the only thing that could plausibly
		// drop it between passes; a second, byte-identical read must restore it.
		const entry = getNetworkInterfaces()[CONCURRENT_AP] as NetworkInterface;
		entry.error = 0;
		entry.enabled = true;

		processIfconfigOutput(hybridTopology());

		expect(
			(getNetworkInterfaces()[CONCURRENT_AP]?.error ?? 0) & NETIF_ERR_HOTSPOT,
		).toBe(NETIF_ERR_HOTSPOT);
		expect(genSrtlaIpList()).not.toContain(AP_ADDRESS);
	});

	test("the pure gate flags every `clap-` netdev and nothing else", () => {
		const interfaces: Record<string, NetworkInterface> = {
			[CONCURRENT_AP]: iface(),
			"clap-wlan1": iface({ ip: "10.42.1.1" }),
			wlan0: iface({ ip: "192.168.1.50" }),
			eth0: iface({ ip: "192.168.78.132" }),
		};

		applyConcurrentApBondGate(interfaces);

		expect(interfaces[CONCURRENT_AP]?.error).toBe(NETIF_ERR_HOTSPOT);
		expect(interfaces["clap-wlan1"]?.error).toBe(NETIF_ERR_HOTSPOT);
		expect(interfaces.wlan0?.error).toBe(0);
		expect(interfaces.eth0?.error).toBe(0);
	});
});
