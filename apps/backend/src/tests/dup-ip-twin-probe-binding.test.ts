/**
 * A DUP-IP TWIN'S HEALTH PROBE IS BOUND TO THE DEVICE, NEVER TO ITS ADDRESS.
 *
 * `connectivity-device-binding.test.ts` pins the DEFAULT-ROUTE ELECTION half of
 * this: `electConnectivityCandidate` dispatches on `ProbeCandidate.binding`, so
 * a dup-IP twin is dialled with `curl --interface`. That is a different caller
 * from the one this file covers.
 *
 * `uplink-health/runtime.ts` runs its OWN probe round on a 5 s cadence, and its
 * verdict is what `state-builder.ts` reads to decide whether a link may carry
 * shared-client traffic at all (`record?.state === "down"` drops the candidate
 * outright). If that probe steered by SOURCE ADDRESS the bench twins would get
 * ONE shared verdict — both leasing `192.168.8.100`, the kernel picking whichever
 * route it liked — so one twin's WAN outage would silently condemn its sibling,
 * or mask its own failure behind the sibling's success. Neither error is visible
 * from a record: both twins simply read `up` or `down` together.
 *
 * The four assertions below are the audit's answer, and they are deliberately at
 * four different layers, because none of them alone is the property:
 *
 *   1. ELIGIBILITY — the twins reach the health round at all, each carrying a
 *      `device` binding. (`probeExclusionReason` still refuses them for the
 *      source-address path; that split is todo 13's and is re-asserted here.)
 *   2. ARGV — the shipped `buildDeviceBoundProbeArgv` names the INTERFACE and
 *      never the shared address, for either twin.
 *   3. RUNTIME — a real `UplinkHealthRuntime` tick probes each twin under its
 *      own interface name, and a WAN outage behind one leaves the other alone.
 *   4. WIRING — the shipped default probe really is the device-bound one. A
 *      behavioural test cannot reach that: every runtime case above injects the
 *      probe, so it would assert the double. Locked at the source instead, the
 *      `udev-rules-sigusr2-scope` / `bluetooth-runtime` precedent, comment-
 *      stripped so this prose cannot satisfy it.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { eligibleProbeCandidates } from "../modules/network/connectivity-candidates.ts";
import {
	buildDeviceBoundProbeArgv,
	type DeviceBoundProbeDeps,
	probeConnectivityViaDevice,
} from "../modules/network/device-bound-probe.ts";
import {
	NETIF_ERR_DUPIPV4,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";
import {
	type ProbeTargetClass,
	setUplinkHealthEngineForTest,
	UPLINK_HEALTH_CONFIG,
	type UplinkHealthOutcome,
	type UplinkHealthRecord,
	UplinkHealthRuntime,
} from "../modules/network/uplink-health/index.ts";
import type { UplinkHealthRuntimeDeps } from "../modules/network/uplink-health/runtime.ts";

/**
 * The bench pair, verbatim. Two physically distinct Huawei E3372 HiLink dongles
 * shipping ONE factory MAC: systemd can only name one of them predictably, the
 * other keeps its kernel default, and BOTH lease `192.168.8.100`.
 */
const TWIN_A = "enx0c5b8f279a64";
const TWIN_B = "eth1";
const TWIN_IP = "192.168.8.100";
const LAN_IF = "eth0";
const LAN_IP = "192.168.78.132";

/** The externally-resolved connectivity-check address (www.gstatic.com A). */
const EXTERNAL_ADDR = "142.251.133.99";

function iface(over: Partial<NetworkInterface> = {}): NetworkInterface {
	return {
		ip: LAN_IP,
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
		...over,
	};
}

const TWIN_NETIF: Record<string, NetworkInterface> = {
	[LAN_IF]: iface(),
	[TWIN_A]: iface({ ip: TWIN_IP, enabled: false, error: NETIF_ERR_DUPIPV4 }),
	[TWIN_B]: iface({ ip: TWIN_IP, enabled: false, error: NETIF_ERR_DUPIPV4 }),
};

// ─── 1. Eligibility ──────────────────────────────────────────────────────────

describe("a dup-IP twin reaches the health round, bound to its device", () => {
	test("both twins are candidates, and both carry a `device` binding", () => {
		const bindings = new Map(
			eligibleProbeCandidates(TWIN_NETIF).map((candidate) => [
				candidate.name,
				candidate.binding,
			]),
		);

		expect([...bindings.keys()].sort()).toEqual(
			[LAN_IF, TWIN_A, TWIN_B].sort(),
		);
		expect(bindings.get(TWIN_A)).toEqual({ kind: "device", ifname: TWIN_A });
		expect(bindings.get(TWIN_B)).toEqual({ kind: "device", ifname: TWIN_B });
		// Non-vacuity: an ordinary uplink is still steered by its address, so the
		// `device` answers above are a property of the collision and not of the
		// function always saying `device`.
		expect(bindings.get(LAN_IF)).toEqual({ kind: "source-ip", ip: LAN_IP });
	});
});

// ─── 2. Argv ─────────────────────────────────────────────────────────────────

describe("the shipped argv names the interface, never the shared address", () => {
	test("each twin's probe carries its OWN `--interface` element", () => {
		for (const twin of [TWIN_A, TWIN_B]) {
			const argv = buildDeviceBoundProbeArgv(EXTERNAL_ADDR, twin);
			const at = argv.indexOf("--interface");
			expect(at).toBeGreaterThan(-1);
			expect(argv[at + 1]).toBe(twin);
		}
	});

	test("the shared lease appears nowhere in either twin's argv", () => {
		for (const twin of [TWIN_A, TWIN_B]) {
			expect(buildDeviceBoundProbeArgv(EXTERNAL_ADDR, twin)).not.toContain(
				TWIN_IP,
			);
		}
	});

	test("the two twins produce argvs that differ ONLY in the bound device", () => {
		const a = buildDeviceBoundProbeArgv(EXTERNAL_ADDR, TWIN_A);
		const b = buildDeviceBoundProbeArgv(EXTERNAL_ADDR, TWIN_B);
		expect(a).not.toEqual(b);
		expect(a.filter((token) => token !== TWIN_A)).toEqual(
			b.filter((token) => token !== TWIN_B),
		);
	});

	test("the probe reaches curl through that argv, per twin", async () => {
		const argvs: string[][] = [];
		const deps: DeviceBoundProbeDeps = {
			shouldUseMocks: () => false,
			runProbe: async (argv) => {
				argvs.push(argv);
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};

		await probeConnectivityViaDevice(EXTERNAL_ADDR, TWIN_A, deps);
		await probeConnectivityViaDevice(EXTERNAL_ADDR, TWIN_B, deps);

		expect(argvs.map((argv) => argv[argv.indexOf("--interface") + 1])).toEqual([
			TWIN_A,
			TWIN_B,
		]);
	});
});

// ─── 3. Runtime ──────────────────────────────────────────────────────────────

/** A tick harness over the REAL `UplinkHealthRuntime` and the REAL engine. */
function healthHarness(
	outcomeFor: (iface: string) => UplinkHealthOutcome,
	now: () => number,
): {
	readonly runtime: UplinkHealthRuntime;
	readonly probed: Array<{ iface: string; target: ProbeTargetClass }>;
	readonly published: UplinkHealthRecord[][];
} {
	const probed: Array<{ iface: string; target: ProbeTargetClass }> = [];
	const published: UplinkHealthRecord[][] = [];
	const deps: UplinkHealthRuntimeDeps = {
		now,
		interfaces: () => TWIN_NETIF,
		streaming: () => false,
		telemetry: () => null,
		probe: async (iface, target) => {
			probed.push({ iface, target });
			return outcomeFor(iface);
		},
		publish: (records) => published.push([...records]),
	};
	return { runtime: new UplinkHealthRuntime(deps), probed, published };
}

describe("the health round probes each twin as its own device", () => {
	beforeEach(() => {
		setUplinkHealthEngineForTest(null);
	});

	test("one tick probes both twins, each under its own interface name", async () => {
		const h = healthHarness(
			() => "success",
			() => 0,
		);
		await h.runtime.tick();

		expect(h.probed.map((entry) => entry.iface).sort()).toEqual(
			[LAN_IF, TWIN_A, TWIN_B].sort(),
		);
		// One probe per interface per round: a shared verdict re-used across the
		// pair would show up here as a missing dispatch.
		expect(h.probed).toHaveLength(3);
	});

	test("a WAN outage behind ONE twin never condemns its sibling", async () => {
		let clock = 0;
		const h = healthHarness(
			(iface) => (iface === TWIN_B ? "failure" : "success"),
			() => clock,
		);

		for (
			let round = 0;
			round < UPLINK_HEALTH_CONFIG.failedRoundsDown;
			round++
		) {
			clock += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs;
			await h.runtime.tick();
		}

		const byIface = new Map(
			h.runtime.records().map((record) => [record.iface, record]),
		);
		expect(byIface.get(TWIN_B)?.state).toBe("down");
		expect(byIface.get(TWIN_B)?.reason).toBe("probe_failed");
		// The sibling shares the failing twin's ADDRESS and nothing else, so it
		// must still be electable and still eligible for client steering.
		expect(byIface.get(TWIN_A)?.state).toBe("up");
		expect(h.runtime.isClientSteeringEligible(TWIN_A)).toBe(true);
		expect(h.runtime.isClientSteeringEligible(TWIN_B)).toBe(false);
	});

	test("the failing twin alone loses its steering weight", async () => {
		let clock = 0;
		const h = healthHarness(
			(iface) => (iface === TWIN_A ? "failure" : "success"),
			() => clock,
		);

		for (
			let round = 0;
			round < UPLINK_HEALTH_CONFIG.failedRoundsDown;
			round++
		) {
			clock += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs;
			await h.runtime.tick();
		}

		const weights = new Map(
			h.runtime.records().map((record) => [record.iface, record.weight]),
		);
		// The mirror of the case above, so neither verdict can be an artefact of
		// which twin the fixture happens to name first.
		expect(weights.get(TWIN_A)).toBe(0);
		expect(weights.get(TWIN_B)).toBe(100);
	});
});

// ─── 4. Wiring ───────────────────────────────────────────────────────────────

describe("the SHIPPED default probe is the device-bound one", () => {
	test("static wiring lock on uplink-health/runtime.ts", () => {
		const source = readFileSync(
			new URL("../modules/network/uplink-health/runtime.ts", import.meta.url),
			"utf8",
		).replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

		expect(source).toContain("probeConnectivityViaDevice");
		expect(source).toContain("probeConnectivityViaDevice(");
		// The candidate's own interface name is what reaches the probe.
		expect(source).toMatch(
			/probe\(candidate\.name,\s*target\)|probe\(\s*candidate\.name/,
		);
		// A source-address binding must not reappear on this path: it is exactly
		// the steering that cannot name a twin.
		expect(source).not.toContain("localAddress");
		expect(source).not.toContain("sourceAddress");
	});
});
