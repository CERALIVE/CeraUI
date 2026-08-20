/**
 * The dongle marker's WIRE contract: it is stamped onto the `netif` projection
 * only, it is retractable, and it can never reach the bonded source-IP list.
 *
 * The union rows in particular are the whole safety argument of todo 18 — a
 * gated veth is administratively DOWN and address-less, so it never enters the
 * live `netif` map, and surfacing it must not change that.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
	type DongleMetadata,
	type DongleMetadataDeps,
	refreshDongleMetadata,
	resetDongleMetadata,
} from "../modules/network/dongle-metadata.ts";
import {
	getNetworkInterfaces,
	netIfBuildMsg,
	processIfconfigOutput,
	resetDongleMarkerTracking,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import {
	collectPolicyRouteCandidates,
	isBondedModemOrWifiIface,
	resetPolicyRouteFlags,
} from "../modules/network/policy-route-check.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import { genSrtlaIpList } from "../modules/streaming/srtla.ts";

const NOW = 1_755_331_200_000;

function record(over: Partial<DongleMetadata> = {}): DongleMetadata {
	return {
		version: 1,
		slot: 0,
		ifname: "eth1",
		usb_path: "platform-fc800000.usb-usb-0:1.3.2",
		mac: "0c:5b:8f:27:9a:64",
		driver: "cdc_ether",
		inner_ip: "192.168.8.100",
		inner_gateway: "192.168.8.1",
		veth_host: "dg0h",
		veth_host_ip: "10.208.0.1",
		state: "up",
		updated_at_ms: NOW,
		lease_refresh_ms: 30000,
		...over,
	};
}

function metadataDeps(records: DongleMetadata[]): DongleMetadataDeps {
	const files: Record<string, string> = {};
	for (const r of records) {
		files[`/run/ceralive/dongles/dongle${r.slot}.json`] = JSON.stringify(r);
	}
	return {
		listFiles: async () => Object.keys(files),
		readFile: async (path) => files[path],
		now: () => NOW,
	};
}

// The existing minimal `ifconfig` stanza shape (RUNNING flag + inet + netmask +
// the mandatory double space in `TX packets N  bytes N`).
function ifconfigStanza(
	name: string,
	ip: string,
	netmask = "255.255.255.0",
): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask ${netmask}  broadcast 192.168.0.255`,
		"        ether aa:bb:cc:dd:ee:ff  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

function ifconfig(...stanzas: string[]): string {
	return stanzas.join("\n\n");
}

function resetState(): void {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const name of ["dg0h", "dg1h", "eth0", "usb0", "enx344b50000000"]) {
		setNetifDupIpSuppression(name, false);
	}
	resetPolicyRouteFlags();
	resetDongleMetadata();
	resetDongleMarkerTracking();
	setQueueUpdateGwHook(null);
}

beforeEach(() => {
	resetState();
});

describe("dongle marker — live rows", () => {
	test("a live dg<N>h row is stamped with its slot and state", async () => {
		await refreshDongleMetadata(metadataDeps([record()]));
		processIfconfigOutput(ifconfig(ifconfigStanza("dg0h", "10.208.0.1")));

		const msg = netIfBuildMsg();
		expect(msg.dg0h?.dongle).toEqual({ slot: 0, state: "up" });
		expect(msg.dg0h?.ip).toBe("10.208.0.1");
		expect(msg.dg0h?.enabled).toBe(true);
	});

	test("a non-dongle row is byte-identical — the field is simply absent", async () => {
		await refreshDongleMetadata(metadataDeps([record()]));
		processIfconfigOutput(
			ifconfig(
				ifconfigStanza("dg0h", "10.208.0.1"),
				ifconfigStanza("eth0", "192.168.78.132"),
			),
		);

		const msg = netIfBuildMsg();
		expect(msg.eth0).toBeDefined();
		expect("dongle" in (msg.eth0 ?? {})).toBe(false);
	});

	// A veth-SHAPED name with no claim behind it must never be marked — shape is
	// not evidence, exactly as `isDongleVethName` is not `getDongleMarker`.
	test("an unclaimed veth-shaped interface is never marked", () => {
		processIfconfigOutput(ifconfig(ifconfigStanza("dg7h", "10.208.7.1")));

		expect("dongle" in (netIfBuildMsg().dg7h ?? {})).toBe(false);
	});
});

describe("dongle marker — union rows are WIRE-ONLY", () => {
	test("an acquiring dongle with no live veth is unioned into the wire", async () => {
		await refreshDongleMetadata(
			metadataDeps([
				record({ state: "acquiring", inner_ip: null, inner_gateway: null }),
			]),
		);
		processIfconfigOutput(ifconfig(ifconfigStanza("eth0", "192.168.78.132")));

		const msg = netIfBuildMsg();
		expect(msg.dg0h).toEqual({
			tp: 0,
			enabled: false,
			tx_bps: 0,
			rx_bps: 0,
			dongle: { slot: 0, state: "acquiring" },
		});
		expect(msg.dg0h?.ip).toBeUndefined();
	});

	test("a down dongle is unioned the same way", async () => {
		await refreshDongleMetadata(metadataDeps([record({ state: "down" })]));

		expect(netIfBuildMsg().dg0h?.dongle).toEqual({ slot: 0, state: "down" });
	});

	// THE load-bearing assertion: a union row exists on the wire while the bonded
	// source-IP list stays empty, because the live map was never touched.
	test("a union row coexists with an EMPTY bonded IP list", async () => {
		await refreshDongleMetadata(
			metadataDeps([
				record({ state: "acquiring", inner_ip: null, inner_gateway: null }),
			]),
		);

		expect(netIfBuildMsg().dg0h?.dongle?.state).toBe("acquiring");
		expect(getNetworkInterfaces().dg0h).toBeUndefined();
		expect(genSrtlaIpList()).toEqual([]);
	});

	test("a union row never displaces a real interface from the bonded list", async () => {
		await refreshDongleMetadata(metadataDeps([record({ state: "down" })]));
		processIfconfigOutput(ifconfig(ifconfigStanza("eth0", "192.168.78.132")));

		expect(netIfBuildMsg().dg0h?.dongle?.state).toBe("down");
		expect(genSrtlaIpList()).toEqual(["192.168.78.132"]);
	});

	// An `up` dongle's veth IS gated up and address-bearing, so it arrives as a
	// real row; unioning it as well would publish a second, contradictory row.
	test("an up dongle with a live veth is stamped, never duplicated as a union row", async () => {
		await refreshDongleMetadata(metadataDeps([record()]));
		processIfconfigOutput(ifconfig(ifconfigStanza("dg0h", "10.208.0.1")));

		const msg = netIfBuildMsg();
		expect(msg.dg0h?.ip).toBe("10.208.0.1");
		expect(msg.dg0h?.enabled).toBe(true);
		expect(genSrtlaIpList()).toEqual(["10.208.0.1"]);
	});

	test("an up dongle whose veth never surfaced is NOT unioned", async () => {
		await refreshDongleMetadata(metadataDeps([record()]));

		expect(netIfBuildMsg().dg0h).toBeUndefined();
	});
});

describe("dongle marker — retraction", () => {
	test("a released LIVE dongle emits one dongle:null frame on its own row", async () => {
		await refreshDongleMetadata(metadataDeps([record()]));
		processIfconfigOutput(ifconfig(ifconfigStanza("dg0h", "10.208.0.1")));
		expect(netIfBuildMsg().dg0h?.dongle).toEqual({ slot: 0, state: "up" });

		await refreshDongleMetadata(metadataDeps([]));

		const released = netIfBuildMsg();
		expect(released.dg0h?.dongle).toBeNull();
		expect(released.dg0h?.ip).toBe("10.208.0.1");
	});

	test("the retraction is emitted ONCE, not on every later frame", async () => {
		await refreshDongleMetadata(metadataDeps([record()]));
		processIfconfigOutput(ifconfig(ifconfigStanza("dg0h", "10.208.0.1")));
		netIfBuildMsg();
		await refreshDongleMetadata(metadataDeps([]));
		netIfBuildMsg();

		expect("dongle" in (netIfBuildMsg().dg0h ?? {})).toBe(false);
	});

	test("a released UNION-only dongle emits one final dongle:null row", async () => {
		await refreshDongleMetadata(metadataDeps([record({ state: "acquiring" })]));
		expect(netIfBuildMsg().dg0h?.dongle?.state).toBe("acquiring");

		await refreshDongleMetadata(metadataDeps([]));

		expect(netIfBuildMsg().dg0h).toEqual({
			tp: 0,
			enabled: false,
			dongle: null,
		});
	});

	test("after its final frame a union-only row stops being emitted", async () => {
		await refreshDongleMetadata(metadataDeps([record({ state: "acquiring" })]));
		netIfBuildMsg();
		await refreshDongleMetadata(metadataDeps([]));
		netIfBuildMsg();

		expect(netIfBuildMsg().dg0h).toBeUndefined();
	});

	// Plain absence must keep meaning "not a dongle" for a row never marked —
	// otherwise every ethernet row would carry a meaningless retraction.
	test("a row never marked never receives a retraction", async () => {
		await refreshDongleMetadata(metadataDeps([record()]));
		processIfconfigOutput(
			ifconfig(
				ifconfigStanza("dg0h", "10.208.0.1"),
				ifconfigStanza("eth0", "192.168.78.132"),
			),
		);
		netIfBuildMsg();
		await refreshDongleMetadata(metadataDeps([]));

		expect("dongle" in (netIfBuildMsg().eth0 ?? {})).toBe(false);
	});

	test("a state transition replaces the marker without retracting it", async () => {
		await refreshDongleMetadata(metadataDeps([record({ state: "acquiring" })]));
		netIfBuildMsg();
		await refreshDongleMetadata(metadataDeps([record({ state: "down" })]));

		expect(netIfBuildMsg().dg0h?.dongle).toEqual({ slot: 0, state: "down" });
	});
});

describe("dup-IP honesty is preserved alongside the marker", () => {
	// The bench's two Huawei HiLink units both lease the host 192.168.8.100, and
	// the MM-managed same-IP report is a Must-NOT-Have of this change. A dongle
	// marker on an unrelated row must not disturb it.
	test("a same-IP pair is still flagged while a dongle row is marked", async () => {
		await refreshDongleMetadata(metadataDeps([record()]));
		processIfconfigOutput(
			ifconfig(
				ifconfigStanza("dg0h", "10.208.0.1"),
				ifconfigStanza("usb0", "192.168.8.100", "255.255.255.0"),
				ifconfigStanza("eth0", "192.168.8.100", "255.255.255.0"),
			),
		);

		const msg = netIfBuildMsg();
		expect(msg.usb0?.error).toBe("duplicate IPv4 addr");
		expect(msg.eth0?.error).toBe("duplicate IPv4 addr");
		expect(msg.usb0?.enabled).toBe(false);
		expect(msg.eth0?.enabled).toBe(false);
		expect(msg.dg0h?.dongle).toEqual({ slot: 0, state: "up" });
		expect(msg.dg0h?.error).toBeUndefined();
		// The dup pair is now BONDING-ELIGIBLE (todo 11's policy split) while
		// staying flagged above: two same-IP lines are legal, and the bind-map
		// sidecar is what tells the twins apart. Their flag is unchanged, so every
		// generic source-IP consumer still refuses them.
		expect(genSrtlaIpList()).toEqual([
			"10.208.0.1",
			"192.168.8.100",
			"192.168.8.100",
		]);
	});
});

describe("policy-route candidates", () => {
	test("a dongle veth is NOT a candidate (todo 39), and enx never was", () => {
		expect(isBondedModemOrWifiIface("wlan0")).toBe(true);
		expect(isBondedModemOrWifiIface("usb0")).toBe(true);
		// Retired with the netns layer: nothing creates a `dg*` interface, and an
		// old-image board still holding one is the retirement path's problem.
		expect(isBondedModemOrWifiIface("dg0h")).toBe(false);
		expect(isBondedModemOrWifiIface("dg7h")).toBe(false);
		expect(isBondedModemOrWifiIface("dg0n")).toBe(false);
		// The image dispatcher maps only `enx*0`..`enx*7` by LAST character, so
		// half of correctly-working adapters would false-flag amber.
		expect(isBondedModemOrWifiIface("enx344b50000000")).toBe(false);
		expect(isBondedModemOrWifiIface("enx0c5b8f279a64")).toBe(false);
		expect(isBondedModemOrWifiIface("eth0")).toBe(false);
	});

	test("a roster of nothing but veths and enx collects no candidate at all", () => {
		const candidates = collectPolicyRouteCandidates({
			dg0h: { ip: "10.208.0.1", enabled: true },
			dg1h: { ip: "10.208.1.1", enabled: false },
			dg2h: { enabled: true },
			enx344b50000000: { ip: "192.168.0.169", enabled: true },
			eth0: { ip: "192.168.78.132", enabled: true },
		});

		expect(candidates).toEqual([]);
	});

	// The eligibility rules themselves are unchanged — proven on a class that IS
	// still collected, so retiring the veth did not quietly retire them with it.
	test("enabled + IP-bearing is still what selects a candidate", () => {
		const candidates = collectPolicyRouteCandidates({
			usb0: { ip: "10.0.0.5", enabled: true },
			usb1: { ip: "10.0.1.5", enabled: false },
			usb2: { enabled: true },
			eth0: { ip: "192.168.78.132", enabled: true },
		});

		expect(candidates).toEqual([{ name: "usb0", ip: "10.0.0.5" }]);
	});
});

describe("gateway re-election is re-queued on a topology edge", () => {
	test("an interface appearing re-queues the one-shot election", () => {
		let queued = 0;
		setQueueUpdateGwHook(() => {
			queued++;
		});

		processIfconfigOutput(ifconfig(ifconfigStanza("eth0", "192.168.78.132")));
		expect(queued).toBe(1);

		// A steady-state poll is not a topology edge.
		processIfconfigOutput(ifconfig(ifconfigStanza("eth0", "192.168.78.132")));
		expect(queued).toBe(1);

		processIfconfigOutput("");
		expect(queued).toBe(2);
	});

	test("an unwired hook is a no-op, never a throw", () => {
		setQueueUpdateGwHook(null);
		expect(() =>
			processIfconfigOutput(ifconfig(ifconfigStanza("eth0", "192.168.78.132"))),
		).not.toThrow();
	});
});
