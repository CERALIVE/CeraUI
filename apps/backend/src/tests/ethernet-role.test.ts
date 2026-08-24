/**
 * The Ethernet port role — `uplink` (today's behaviour) vs `shared-lan`.
 *
 * The suite drives the REAL `processIfconfigOutput`, the REAL `genSrtlaBondEntries`
 * and the REAL `configureNetworkInterfaceProcedure`, because every defect here
 * lives in the WIRING: a test aimed at a pure predicate passes on a tree where
 * nothing ever stamps the flag, and a test aimed at `handleNetif` alone passes on
 * a tree where the procedure discards its answer.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";

import { call } from "@orpc/server";

import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	eligibleProbeCandidates,
	probeExclusionReason,
} from "../modules/network/connectivity-candidates.ts";
import {
	ETHERNET_ROLE_DEFAULT,
	getEthernetRole,
	isEthernetRoleCandidate,
	isSharedLanPort,
	persistEthernetRole,
	restoreEthernetRole,
} from "../modules/network/ethernet-role.ts";
import {
	type EthernetRoleTransitionDeps,
	reconcileEthernetRoles,
	setEthernetRole,
} from "../modules/network/ethernet-role-transition.ts";
import {
	applySharedLanBondGate,
	getNetifErrorMsg,
	getNetworkInterfaces,
	isBondCandidate,
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
	netIfBuildMsg,
	processIfconfigOutput,
	resetBondOptOut,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import { resetPolicyRouteFlags } from "../modules/network/policy-route-check.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import { genSrtlaBondEntries } from "../modules/streaming/srtla.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const SHARED_PORT = "eth1";
const UPLINK_PORT = "eth0";
const UPLINK_IP = "192.168.78.132";
const SHARED_IP = "10.42.0.1";

function ifconfigStanza(name: string, ip: string, mac: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast ${ip.replace(/\.\d+$/, ".255")}`,
		`        ether ${mac}  txqueuelen 1000  (Ethernet)`,
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

function twoPortTopology(): string {
	return [
		ifconfigStanza(UPLINK_PORT, UPLINK_IP, "aa:bb:cc:dd:ee:01"),
		ifconfigStanza(SHARED_PORT, SHARED_IP, "aa:bb:cc:dd:ee:02"),
	].join("\n\n");
}

function iface(over: Partial<NetworkInterface> = {}): NetworkInterface {
	return {
		ip: SHARED_IP,
		netmask: "255.255.255.0",
		txb: 0,
		rxb: 0,
		tp: 0,
		enabled: true,
		error: 0,
		...over,
	} as NetworkInterface;
}

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

/**
 * A transition harness whose NM surface is fully injected, so the persist /
 * rollback / frame ordering is provable with no nmcli on the host.
 */
function makeDeps(
	over: Partial<EthernetRoleTransitionDeps> = {},
): EthernetRoleTransitionDeps & {
	frames: Array<{ name: string; outcome: unknown }>;
	writes: Array<{ uuid: string; fields: Record<string, string> }>;
} {
	const frames: Array<{ name: string; outcome: unknown }> = [];
	const writes: Array<{ uuid: string; fields: Record<string, string> }> = [];
	return {
		frames,
		writes,
		listInterfaces: () => getNetworkInterfaces(),
		resolveConnection: async () => "uuid-eth1",
		setFields: async (uuid, fields) => {
			writes.push({ uuid, fields });
			return true;
		},
		activate: async () => true,
		persistRole: persistEthernetRole,
		restoreRole: restoreEthernetRole,
		readPersistedRole: (ifname) => getConfig().eth_roles?.[ifname],
		publishOutcome: (name, outcome) => {
			frames.push({ name, outcome });
		},
		refreshInterfaces: () => {
			applySharedLanBondGate(getNetworkInterfaces());
		},
		...over,
	};
}

const TEST_CONFIG_FILE = `${process.env.TMPDIR ?? "/tmp"}/ceraui-eth-role-${process.pid}.json`;

let previousConfigFile = "";

beforeEach(() => {
	// `persistEthernetRole` performs a REAL synchronous write, so the repo's own
	// config.json is what it hits without this redirect.
	previousConfigFile = getConfigFilePath();
	setConfigFilePath(TEST_CONFIG_FILE);
	const config = getConfig();
	config.eth_roles = {};

	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const name of [UPLINK_PORT, SHARED_PORT]) {
		setNetifDupIpSuppression(name, false);
	}
	resetBondOptOut();
	resetPolicyRouteFlags();
	setQueueUpdateGwHook(null);
});

afterEach(() => {
	getConfig().eth_roles = {};
	setConfigFilePath(previousConfigFile);
});

afterAll(async () => {
	await Bun.file(TEST_CONFIG_FILE)
		.delete()
		.catch(() => {});
});

describe("the persisted role defaults to uplink", () => {
	test("an untouched port reads `uplink` and is not shared", () => {
		expect(getEthernetRole(UPLINK_PORT)).toBe(ETHERNET_ROLE_DEFAULT);
		expect(ETHERNET_ROLE_DEFAULT).toBe("uplink");
		expect(isSharedLanPort(UPLINK_PORT)).toBe(false);
	});

	test("only wired ports may be given a role", () => {
		for (const name of ["eth0", "eth1", "enx0c5b8f279a64", "enp3s0"]) {
			expect(isEthernetRoleCandidate(name)).toBe(true);
		}
		for (const name of ["wlan0", "usb0", "wwan0", "lo", "clap-wlan0"]) {
			expect(isEthernetRoleCandidate(name)).toBe(false);
		}
	});

	test("restoring `undefined` DELETES the key rather than writing the default", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		expect(getConfig().eth_roles?.[SHARED_PORT]).toBe("shared-lan");

		restoreEthernetRole(SHARED_PORT, undefined);

		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
		expect(getEthernetRole(SHARED_PORT)).toBe("uplink");
	});
});

describe("a shared-lan port leaves every candidate set", () => {
	test("the flip stamps 0x08 and drops the port from bond AND connectivity", () => {
		processIfconfigOutput(twoPortTopology());
		// Non-vacuity: both ports bond before the flip.
		expect(
			genSrtlaBondEntries()
				.map((e) => e.ip)
				.sort(),
		).toEqual([SHARED_IP, UPLINK_IP]);

		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const entry = getNetworkInterfaces()[SHARED_PORT];
		expect((entry?.error ?? 0) & NETIF_ERR_SHAREDLAN).toBe(NETIF_ERR_SHAREDLAN);
		expect(entry?.enabled).toBe(false);

		// The flag is what the wire, the probe rules and the grouping pass all
		// already read, so each inherits the exclusion.
		expect(getNetifErrorMsg(entry as NetworkInterface)).toBe("shared LAN");
		expect(netIfBuildMsg()[SHARED_PORT]?.error).toBe("shared LAN");
		expect(probeExclusionReason(entry)).toBe("shared LAN");
		expect(
			eligibleProbeCandidates(getNetworkInterfaces()).map((c) => c.name),
		).toEqual([UPLINK_PORT]);

		// SRTLA regression: the shared port's address never reaches the bond list.
		const bonded = genSrtlaBondEntries();
		expect(bonded.map((e) => e.ip)).toEqual([UPLINK_IP]);
		expect(bonded.map((e) => e.iface)).not.toContain(SHARED_PORT);
	});

	test("`isBondCandidate` refuses it structurally, even error-free", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");

		expect(isBondCandidate(SHARED_PORT, iface())).toBe(false);
		// Non-vacuity: the identical entry on an uplink port IS a candidate.
		expect(isBondCandidate(UPLINK_PORT, iface())).toBe(true);
	});

	test("the gate re-applies on a pass where NOTHING about the topology moved", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const entry = getNetworkInterfaces()[SHARED_PORT] as NetworkInterface;
		entry.error = 0;
		entry.enabled = true;

		processIfconfigOutput(twoPortTopology());

		expect(
			(getNetworkInterfaces()[SHARED_PORT]?.error ?? 0) & NETIF_ERR_SHAREDLAN,
		).toBe(NETIF_ERR_SHAREDLAN);
		expect(genSrtlaBondEntries().map((e) => e.ip)).toEqual([UPLINK_IP]);
	});

	test("the uplink port beside it is untouched", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const uplink = getNetworkInterfaces()[UPLINK_PORT];
		expect(uplink?.error).toBe(0);
		expect(uplink?.enabled).toBe(true);
		expect(netIfBuildMsg()[UPLINK_PORT]?.ethRole).toBe("uplink");
	});
});

describe("flipping back to uplink restores candidacy", () => {
	test("the flag clears AND the port bonds again", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());
		expect(genSrtlaBondEntries().map((e) => e.ip)).toEqual([UPLINK_IP]);

		persistEthernetRole(SHARED_PORT, "uplink");
		processIfconfigOutput(twoPortTopology());

		const entry = getNetworkInterfaces()[SHARED_PORT];
		expect((entry?.error ?? 0) & NETIF_ERR_SHAREDLAN).toBe(0);
		expect(entry?.enabled).toBe(true);
		expect(getNetifErrorMsg(entry as NetworkInterface)).toBeUndefined();
		expect(
			genSrtlaBondEntries()
				.map((e) => e.ip)
				.sort(),
		).toEqual([SHARED_IP, UPLINK_IP]);
		expect(
			eligibleProbeCandidates(getNetworkInterfaces())
				.map((c) => c.name)
				.sort(),
		).toEqual([UPLINK_PORT, SHARED_PORT].sort());
	});

	test("releasing the flag honours a separate operator bond opt-out", () => {
		const interfaces: Record<string, NetworkInterface> = {
			[SHARED_PORT]: iface({ error: NETIF_ERR_SHAREDLAN, enabled: false }),
		};

		applySharedLanBondGate(interfaces, () => false);

		expect(interfaces[SHARED_PORT]?.error).toBe(0);
		expect(interfaces[SHARED_PORT]?.enabled).toBe(true);
	});

	test("a port carrying ANOTHER error stays down when the role is released", () => {
		const interfaces: Record<string, NetworkInterface> = {
			[SHARED_PORT]: iface({
				error: NETIF_ERR_SHAREDLAN | 0x01,
				enabled: false,
			}),
		};

		applySharedLanBondGate(interfaces, () => false);

		expect(interfaces[SHARED_PORT]?.error).toBe(0x01);
		expect(interfaces[SHARED_PORT]?.enabled).toBe(false);
	});
});

describe("the role transition", () => {
	test("persists, writes `ipv4.method shared`, and emits pending then terminal", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps();

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: true, applied: "shared-lan" });
		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "shared" } },
		]);
		expect(deps.frames.map((f) => f.outcome)).toEqual([
			{ pending: true, role: "shared-lan" },
			{ success: true, role: "shared-lan" },
		]);
		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
	});

	test("flipping back writes `ipv4.method auto`", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		await setEthernetRole(SHARED_PORT, "uplink", deps);

		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "auto" } },
		]);
		expect(getEthernetRole(SHARED_PORT)).toBe("uplink");
	});

	test("a NON-ethernet interface is refused before anything is written", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps();

		const result = await setEthernetRole("wlan0", "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "not_ethernet" });
		expect(deps.writes).toEqual([]);
		expect(getConfig().eth_roles).toEqual({});
	});

	test("an absent interface is refused before anything is written", async () => {
		const deps = makeDeps();

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "unknown_interface" });
		expect(deps.writes).toEqual([]);
	});

	test("a port NetworkManager holds no connection on is refused, and rolls back", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps({ resolveConnection: async () => undefined });

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "no_connection" });
		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
	});

	test("an already-applied role re-states it without touching NetworkManager", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: true, applied: "shared-lan" });
		expect(deps.writes).toEqual([]);
		// Nothing was dispatched, so this branch owes the terminal frame itself —
		// and it owes exactly ONE, with no pending frame before it.
		expect(deps.frames.map((f) => f.outcome)).toEqual([
			{ success: true, role: "shared-lan" },
		]);
	});
});

describe("an NM failure mid-flip leaves NOTHING half-applied", () => {
	test("the role reverts, a typed failure frame lands, and the netif flags are unchanged", async () => {
		processIfconfigOutput(twoPortTopology());
		const before = { ...getNetworkInterfaces()[SHARED_PORT] };

		const deps = makeDeps({ setFields: async () => false });
		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "apply_failed" });
		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
		expect(getEthernetRole(SHARED_PORT)).toBe("uplink");

		expect(deps.frames.map((f) => f.outcome)).toEqual([
			{ pending: true, role: "shared-lan" },
			{ success: false, error: "apply_failed" },
		]);

		// The netif flags never moved: the gate reads the (restored) role, so a
		// refused flip cannot leave the port excluded from the bond.
		const after = getNetworkInterfaces()[SHARED_PORT];
		expect(after?.error).toBe(before.error ?? 0);
		expect(after?.enabled).toBe(before.enabled);
		expect((after?.error ?? 0) & NETIF_ERR_SHAREDLAN).toBe(0);

		processIfconfigOutput(twoPortTopology());
		expect(
			genSrtlaBondEntries()
				.map((e) => e.ip)
				.sort(),
		).toEqual([SHARED_IP, UPLINK_IP]);
	});

	test("a failed ACTIVATION rolls back exactly as a failed write does", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps({ activate: async () => false });

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "apply_failed" });
		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
	});

	test("a rollback restores a PREVIOUS role rather than deleting it", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps({ setFields: async () => false });

		await setEthernetRole(SHARED_PORT, "uplink", deps);

		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
	});
});

describe("boot reconciliation", () => {
	test("re-applies a stated shared-lan role", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "shared" } },
		]);
	});

	test("is IDEMPOTENT — a second run re-asserts the same value and nothing else", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		await reconcileEthernetRoles(deps);
		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "shared" } },
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "shared" } },
		]);
		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
		expect(
			(getNetworkInterfaces()[SHARED_PORT]?.error ?? 0) & NETIF_ERR_SHAREDLAN,
		).toBe(NETIF_ERR_SHAREDLAN);
	});

	test("an `uplink` entry is never re-applied — the default touches no profile", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(UPLINK_PORT, "uplink");
		const deps = makeDeps();

		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([]);
	});

	test("a device with no stated role does nothing at all", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps();

		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([]);
	});

	test("FAIL-SOFT — a throwing NM read never rejects and never clears the role", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps({
			resolveConnection: async () => {
				throw new Error("nmcli exploded");
			},
		});

		await expect(reconcileEthernetRoles(deps)).resolves.toBeUndefined();
		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
	});

	test("FAIL-SOFT — an absent port leaves its role pending rather than discarded", async () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		await expect(reconcileEthernetRoles(deps)).resolves.toBeUndefined();

		expect(deps.writes).toEqual([]);
		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
	});

	test("one port that throws does not cost another its reconciliation", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		persistEthernetRole(UPLINK_PORT, "shared-lan");
		const deps = makeDeps({
			resolveConnection: async (ifname) => {
				if (ifname === SHARED_PORT) throw new Error("nmcli exploded");
				return "uuid-eth0";
			},
		});

		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth0", fields: { "ipv4.method": "shared" } },
		]);
	});
});

describe("network.configure answers honestly when handleNetif rejects", () => {
	test("a stale address is `success:false` with a typed reason, NEVER `success:true`", async () => {
		processIfconfigOutput(twoPortTopology());

		const result = await call(
			configureNetworkInterfaceProcedure,
			// The echoed address is not the one the device observes, so the
			// concurrency guard discards the whole request — including the bond
			// toggle it carries.
			{ name: UPLINK_PORT, ip: "10.9.9.9", enabled: false },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("stale_address");
		// And the guard really did discard it: the toggle did not apply.
		expect(getNetworkInterfaces()[UPLINK_PORT]?.enabled).toBe(true);
	});

	test("an unknown interface is `success:false` with its own reason", async () => {
		processIfconfigOutput(twoPortTopology());

		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: "eth9", enabled: false },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("unknown_interface");
	});

	test("enabling a port the device refuses is `success:false`", async () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: SHARED_PORT, ip: SHARED_IP, enabled: true },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("enable_refused");
	});

	test("an APPLIED toggle still answers `success:true` with its applied fields", async () => {
		processIfconfigOutput(twoPortTopology());

		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: UPLINK_PORT, ip: UPLINK_IP, enabled: false },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.applied).toEqual({
			name: UPLINK_PORT,
			ip: UPLINK_IP,
			enabled: false,
		});
		expect(getNetworkInterfaces()[UPLINK_PORT]?.enabled).toBe(false);
	});
});

describe("the wire carries the role in BOTH directions", () => {
	test("every ethernet row states its role explicitly, `uplink` included", () => {
		processIfconfigOutput(twoPortTopology());

		expect(netIfBuildMsg()[UPLINK_PORT]?.ethRole).toBe("uplink");
		expect(netIfBuildMsg()[SHARED_PORT]?.ethRole).toBe("uplink");
	});

	test("a flip is published, and the flip BACK retracts it explicitly", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());
		expect(netIfBuildMsg()[SHARED_PORT]?.ethRole).toBe("shared-lan");

		persistEthernetRole(SHARED_PORT, "uplink");
		processIfconfigOutput(twoPortTopology());

		// Explicit, never omitted — the consumer merge preserves an absent field,
		// so a retraction by omission could never lower the claim.
		expect(netIfBuildMsg()[SHARED_PORT]).toHaveProperty("ethRole");
		expect(netIfBuildMsg()[SHARED_PORT]?.ethRole).toBe("uplink");
	});

	test("a NON-ethernet row makes no role claim at all", () => {
		processIfconfigOutput(
			[
				ifconfigStanza(UPLINK_PORT, UPLINK_IP, "aa:bb:cc:dd:ee:01"),
				ifconfigStanza("wlan0", "192.168.1.50", "aa:bb:cc:dd:ee:03"),
			].join("\n\n"),
		);

		expect(netIfBuildMsg().wlan0).not.toHaveProperty("ethRole");
	});
});

describe("the wire shape round-trips through the published schema", () => {
	test("a role-bearing netif payload parses", async () => {
		const { netifMessageSchema, setEthernetRoleInputSchema } = await import(
			"@ceraui/rpc/schemas"
		);
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const parsed = netifMessageSchema.safeParse(netIfBuildMsg());
		expect(parsed.success).toBe(true);
		expect(parsed.data?.[SHARED_PORT]?.ethRole).toBe("shared-lan");

		expect(
			setEthernetRoleInputSchema.safeParse({
				name: SHARED_PORT,
				role: "shared-lan",
			}).success,
		).toBe(true);
		// `.strict()`: an unknown extra key on a control that re-points a wired
		// port at the LAN must be REJECTED, never ignored.
		expect(
			setEthernetRoleInputSchema.safeParse({
				name: SHARED_PORT,
				role: "shared-lan",
				extra: true,
			}).success,
		).toBe(false);
		expect(
			setEthernetRoleInputSchema.safeParse({ name: SHARED_PORT, role: "wan" })
				.success,
		).toBe(false);
	});

	test("the outcome frame parses in all three shapes", async () => {
		const { ethernetRoleMessageSchema } = await import("@ceraui/rpc/schemas");

		for (const frame of [
			{ eth_role: { name: SHARED_PORT, role: "shared-lan", pending: true } },
			{ eth_role: { name: SHARED_PORT, role: "shared-lan", success: true } },
			{ eth_role: { name: SHARED_PORT, error: "apply_failed" } },
		]) {
			expect(ethernetRoleMessageSchema.safeParse(frame).success).toBe(true);
		}
	});
});

describe("the policy-route check now covers ethernet uplinks", () => {
	test("a wired port with NO rule is withheld, not flagged", async () => {
		const { checkPolicyRoutes } = await import(
			"../modules/network/policy-route-check.ts"
		);
		const rules = `0:\tfrom all lookup local
32766:\tfrom all lookup main
`;
		const flagged = await checkPolicyRoutes(
			{ [UPLINK_PORT]: { ip: UPLINK_IP, enabled: true } },
			{
				isRealDevice: async () => true,
				shouldUseMocks: () => false,
				resolveMockPolicyRouteMissing: () => null,
				runIpRuleShow: mock(async () => rules),
				runIpRouteShowTable: mock(async () => ""),
			},
		);

		expect([...(flagged ?? [])]).toEqual([]);
	});

	test("a wired port WITH a rule whose table has no default route IS flagged", async () => {
		const { checkPolicyRoutes } = await import(
			"../modules/network/policy-route-check.ts"
		);
		const rules = `0:\tfrom all lookup local
100:\tfrom ${UPLINK_IP} lookup 108
32766:\tfrom all lookup main
`;
		const flagged = await checkPolicyRoutes(
			{ [UPLINK_PORT]: { ip: UPLINK_IP, enabled: true } },
			{
				isRealDevice: async () => true,
				shouldUseMocks: () => false,
				resolveMockPolicyRouteMissing: () => null,
				runIpRuleShow: mock(async () => rules),
				runIpRouteShowTable: mock(async () => ""),
			},
		);

		expect([...(flagged ?? [])]).toEqual([UPLINK_PORT]);
	});

	test("a shared-lan port is not an uplink, so it is never a candidate", async () => {
		const { collectEthernetPolicyRouteCandidates } = await import(
			"../modules/network/policy-route-check.ts"
		);
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const candidates = collectEthernetPolicyRouteCandidates(
			getNetworkInterfaces(),
		);

		expect(candidates.map((c) => c.name)).toEqual([UPLINK_PORT]);
	});
});
