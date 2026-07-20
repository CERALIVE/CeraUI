import { beforeEach, describe, expect, test } from "bun:test";

import {
	buildRtmpUrl,
	buildSrtUrl,
	resolvePrimaryLanIp,
} from "../modules/network/network-ingest.ts";
import {
	getNetworkInterfaces,
	netIfBuildMsg,
	parseIpAddrShow,
	processIfconfigOutput,
	setNetifDupIpSuppression,
} from "../modules/network/network-interfaces.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";

// Verbatim from the live board (192.168.78.131): eth0 carries BOTH an RFC-3927
// link-local (`scope link`) AND the real DHCP lease (`scope global dynamic`).
// This is the exact multi-address shape `ip -4 addr show` reports and that
// single-address ifconfig cannot express.
const IP_ADDR_SHOW_REAL_BOARD = [
	"1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000",
	"    inet 127.0.0.1/8 scope host lo",
	"       valid_lft forever preferred_lft forever",
	"2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000",
	"    inet 169.254.149.160/16 brd 169.254.255.255 scope link noprefixroute eth0",
	"    inet 192.168.78.131/24 brd 192.168.78.255 scope global dynamic noprefixroute eth0",
	"       valid_lft 84567sec preferred_lft 84567sec",
].join("\n");

// What `/sbin/ifconfig eth0` reports on that SAME board: ONLY the link-local.
// The DHCP address is absent from ifconfig's output entirely.
const IFCONFIG_ETH0_LINK_LOCAL_ONLY = [
	"eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500",
	"        inet 169.254.149.160  netmask 255.255.0.0  broadcast 169.254.255.255",
	"        ether 00:48:54:20:42:e3  txqueuelen 1000  (Ethernet)",
	"        RX packets 200  bytes 20000 (20.0 KB)",
	"        TX packets 100  bytes 1000 (1.0 KB)",
].join("\n");

function resetState(): void {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const name of ["eth0", "lo"]) setNetifDupIpSuppression(name, false);
}

beforeEach(() => {
	resetState();
});

describe("parseIpAddrShow scope preference", () => {
	test("prefers the global-scope DHCP lease over the link-local on the real board", () => {
		const selected = parseIpAddrShow(IP_ADDR_SHOW_REAL_BOARD);

		expect(selected.get("eth0")).toEqual({
			ip: "192.168.78.131",
			netmask: "255.255.255.0",
		});
		expect(selected.get("lo")).toEqual({
			ip: "127.0.0.1",
			netmask: "255.0.0.0",
		});
	});

	test("falls back to the link-local when it is the only address", () => {
		const linkLocalOnly = [
			"2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500",
			"    inet 169.254.149.160/16 brd 169.254.255.255 scope link noprefixroute eth0",
		].join("\n");

		expect(parseIpAddrShow(linkLocalOnly).get("eth0")).toEqual({
			ip: "169.254.149.160",
			netmask: "255.255.0.0",
		});
	});

	test("takes the first global address when several are present", () => {
		const multiGlobal = [
			"2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500",
			"    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0",
			"    inet 192.168.1.9/24 brd 192.168.1.255 scope global secondary eth0",
		].join("\n");

		expect(parseIpAddrShow(multiGlobal).get("eth0")?.ip).toBe("10.0.0.5");
	});

	test("keys a VLAN sub-interface by its base name", () => {
		const vlan = [
			"7: eth0.10@eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500",
			"    inet 192.168.20.4/24 brd 192.168.20.255 scope global eth0.10",
		].join("\n");

		const selected = parseIpAddrShow(vlan);
		expect(selected.get("eth0.10")).toEqual({
			ip: "192.168.20.4",
			netmask: "255.255.255.0",
		});
	});

	test("returns an empty map for empty or address-less output", () => {
		expect(parseIpAddrShow("").size).toBe(0);
		expect(parseIpAddrShow("garbage\nno interfaces here").size).toBe(0);
	});
});

describe("netif IP selection end-to-end (the LAN-ingest bug)", () => {
	test("the ip override corrects eth0 to the DHCP lease and drives the LAN-ingest URLs", () => {
		const overrides = parseIpAddrShow(IP_ADDR_SHOW_REAL_BOARD);
		processIfconfigOutput(IFCONFIG_ETH0_LINK_LOCAL_ONLY, overrides);

		const eth0 = getNetworkInterfaces().eth0;
		expect(eth0?.ip).toBe("192.168.78.131");
		expect(eth0?.netmask).toBe("255.255.255.0");
		expect(netIfBuildMsg().eth0?.ip).toBe("192.168.78.131");

		const lanIp = resolvePrimaryLanIp(getNetworkInterfaces());
		expect(lanIp).toBe("192.168.78.131");
		expect(buildRtmpUrl(lanIp ?? "")).toBe(
			"rtmp://192.168.78.131:1935/publish/live",
		);
		expect(buildSrtUrl(lanIp ?? "")).toBe("srt://192.168.78.131:4001");
	});

	test("without an override it degrades to ifconfig's single (link-local) address", () => {
		processIfconfigOutput(IFCONFIG_ETH0_LINK_LOCAL_ONLY);

		expect(getNetworkInterfaces().eth0?.ip).toBe("169.254.149.160");
		expect(resolvePrimaryLanIp(getNetworkInterfaces())).toBe("169.254.149.160");
	});
});
