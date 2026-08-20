/**
 * A SIM-LESS ROUTER DONGLE MUST NEVER REACH `genSrtlaIpList()`.
 *
 * This case had NO coverage, which is why it shipped: every existing bond test
 * reasons about a directly-managed modem, whose SIM slot rides `no_sim`. A
 * `router-ethernet` dongle is invisible to ModemManager and reports its slot
 * through its OWN admin API, so it fell through the gate entirely — and, because
 * it still leases the host a perfectly good address from its embedded router, it
 * looked bondable to every rule that reads only an address.
 *
 * Measured on the bench board: a SIM-less ZTE MF79U (`192.168.0.169`) and a
 * SIM-less Qualcomm UFI were both in the srtla source-IP list while their
 * SIM-less Huawei siblings were not — and the only thing separating the two
 * pairs was that the Huaweis happened to collide on `NETIF_ERR_DUPIPV4` as well,
 * so their exclusion was an accident of a different rule rather than this one
 * working.
 *
 * The suite drives the REAL `processIfconfigOutput` against the REAL admin
 * cache, because the defect lived in the wiring rather than in any predicate: a
 * test aimed at the pure rule alone passes on the broken tree.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
	applyRouterSimBondGate,
	getNetworkInterfaces,
	isBondCandidate,
	NETIF_ERR_NOSIM,
	type NetworkInterface,
	netIfBuildMsg,
	processIfconfigOutput,
	resetBondOptOut,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import { resetPolicyRouteFlags } from "../modules/network/policy-route-check.ts";
import {
	type RouterAdminProbeDeps,
	refreshRouterCellularAdmin,
	resetRouterCellularAdmin,
} from "../modules/network/router-cellular-admin.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import { genSrtlaIpList } from "../modules/streaming/srtla.ts";

// Verbatim from the bench ZTE MF79U with no card in it. `modem_sim_undetected`
// is the device's OWN word for the slot being empty — the only kind of evidence
// this gate acts on.
const ZTE_NO_SIM = `{"modem_main_state":"modem_sim_undetected","ppp_status":"ppp_disconnected","signalbar":"","apn_name":""}`;
const ZTE_WITH_SIM = `{"modem_main_state":"modem_init_complete","ppp_status":"ppp_connected","signalbar":"4","apn_name":"internet"}`;

const ROUTE_OUTPUT =
	"default via 192.168.0.1 dev enx344b50000000 proto dhcp src 192.168.0.169 metric 103 \n" +
	"default via 192.168.78.1 dev eth0 proto dhcp src 192.168.78.132 metric 101 ";

function ifconfigStanza(name: string, ip: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast 192.168.0.255`,
		"        ether 34:4b:50:00:00:00  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

function ifconfig(...stanzas: string[]): string {
	return stanzas.join("\n\n");
}

function probeDeps(body: string): RouterAdminProbeDeps {
	return {
		isRealDevice: async () => true,
		runIpRouteShowDefault: async () => ROUTE_OUTPUT,
		fetchViaInterface: async (_ifname, urls) => urls.map(() => body),
		postViaInterface: async () => "",
	};
}

async function seedAdmin(body: string): Promise<void> {
	await refreshRouterCellularAdmin(
		new Map([["enx344b50000000", "19d2:1405"]]),
		probeDeps(body),
	);
}

function iface(over: Partial<NetworkInterface> = {}): NetworkInterface {
	return {
		ip: "192.168.0.169",
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
	for (const name of ["enx344b50000000", "eth0"]) {
		setNetifDupIpSuppression(name, false);
	}
	resetBondOptOut();
	resetPolicyRouteFlags();
	resetRouterCellularAdmin();
	setQueueUpdateGwHook(null);
});

describe("the SIM-less dongle never reaches the real bond list", () => {
	test("a dongle whose own admin API reports an empty slot is excluded", async () => {
		await seedAdmin(ZTE_NO_SIM);
		processIfconfigOutput(
			ifconfig(
				ifconfigStanza("enx344b50000000", "192.168.0.169"),
				ifconfigStanza("eth0", "192.168.78.132"),
			),
		);

		expect(genSrtlaIpList()).toEqual(["192.168.78.132"]);
	});

	// The mirror the frontend renders from: `isBondMember` reads `enabled && ip`
	// off this payload, so a gate that excluded the link from srtla without
	// lowering `enabled` would leave the UI claiming a bonded link the device is
	// not bonding.
	test("…and the wire says so, so the UI mirror cannot disagree", async () => {
		await seedAdmin(ZTE_NO_SIM);
		processIfconfigOutput(
			ifconfig(ifconfigStanza("enx344b50000000", "192.168.0.169")),
		);

		const entry = netIfBuildMsg().enx344b50000000;
		expect(entry?.enabled).toBe(false);
		expect(entry?.error).toBe("no SIM");
	});

	test("a dongle holding a SIM is bonded exactly as before", async () => {
		await seedAdmin(ZTE_WITH_SIM);
		processIfconfigOutput(
			ifconfig(ifconfigStanza("enx344b50000000", "192.168.0.169")),
		);

		expect(genSrtlaIpList()).toEqual(["192.168.0.169"]);
		expect(netIfBuildMsg().enx344b50000000?.enabled).toBe(true);
	});

	// The self-correction the operator sees: a link already sitting in the bond
	// leaves it on the next state read, with no operator action and no restart.
	test("a link already bonded self-corrects on the next read", async () => {
		await seedAdmin(ZTE_WITH_SIM);
		processIfconfigOutput(
			ifconfig(ifconfigStanza("enx344b50000000", "192.168.0.169")),
		);
		expect(genSrtlaIpList()).toEqual(["192.168.0.169"]);

		await seedAdmin(ZTE_NO_SIM);
		processIfconfigOutput(
			ifconfig(ifconfigStanza("enx344b50000000", "192.168.0.169")),
		);

		expect(genSrtlaIpList()).toEqual([]);
	});

	// The netif map is byte-identical across a SIM being pulled from a dongle
	// that keeps its lease, so a gate wired into the `intsChanged` branch — where
	// its dup-IP sibling lives — would never fire for the case it exists for.
	test("the verdict is re-read on a pass with no topology change", async () => {
		await seedAdmin(ZTE_WITH_SIM);
		processIfconfigOutput(
			ifconfig(ifconfigStanza("enx344b50000000", "192.168.0.169")),
		);

		await seedAdmin(ZTE_NO_SIM);
		// Same addresses, same interface set — `intsChanged` is false here.
		processIfconfigOutput(
			ifconfig(ifconfigStanza("enx344b50000000", "192.168.0.169")),
		);

		expect(getNetworkInterfaces().enx344b50000000?.error).toBe(NETIF_ERR_NOSIM);
	});
});

describe("positive evidence only — an unknown never subtracts", () => {
	test("an unreachable dongle keeps its link", () => {
		const interfaces = { enx344b50000000: iface() };
		applyRouterSimBondGate(interfaces, () => ({ sim: undefined }));

		expect(isBondCandidate("enx344b50000000", interfaces.enx344b50000000)).toBe(
			true,
		);
	});

	test("a dialect that would not justify its SIM code keeps its link", () => {
		const interfaces = { enx344b50000000: iface() };
		applyRouterSimBondGate(interfaces, () => ({ sim: "unknown" }));

		expect(isBondCandidate("enx344b50000000", interfaces.enx344b50000000)).toBe(
			true,
		);
	});

	test("an interface with no admin reading at all keeps its link", () => {
		const interfaces = { eth0: iface({ ip: "192.168.78.132" }) };
		applyRouterSimBondGate(interfaces, () => undefined);

		expect(isBondCandidate("eth0", interfaces.eth0)).toBe(true);
		expect(interfaces.eth0?.error).toBe(0);
	});

	test("a stated empty slot subtracts, and clears again when a card returns", () => {
		const interfaces = { enx344b50000000: iface() };

		applyRouterSimBondGate(interfaces, () => ({ sim: "absent" }));
		expect(isBondCandidate("enx344b50000000", interfaces.enx344b50000000)).toBe(
			false,
		);

		applyRouterSimBondGate(interfaces, () => ({ sim: "present" }));
		expect(interfaces.enx344b50000000?.error).toBe(0);
	});
});
