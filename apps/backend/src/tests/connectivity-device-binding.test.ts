/*
 * Interface-bound connectivity probing (Phase-C todo 13).
 *
 * The duplicate-MAC HiLink twins share ONE leased address (192.168.8.100) and
 * ONE admin gateway address (192.168.8.1), so neither a source address nor a
 * destination address can name a twin. Only the DEVICE can. These tests pin
 * that end to end:
 *
 *   1. BINDING — a dup-IP candidate reaches curl as its own `--interface <name>`
 *      argv element, and the destination stays the externally-resolved
 *      connectivity address.
 *   2. INDEPENDENCE — a WAN outage behind one twin marks ONLY that twin
 *      unreachable; its sibling is elected on its own verdict.
 *   3. SEPARATION — admin-API reachability is never a WAN claim: no gateway or
 *      LAN address is ever a probe target.
 */

import { describe, expect, mock, test } from "bun:test";

import {
	eligibleProbeCandidates,
	type ProbeCandidate,
} from "../modules/network/connectivity-candidates.ts";
import {
	type ConnectivityProbes,
	electConnectivityCandidate,
} from "../modules/network/connectivity-election.ts";
import {
	buildDeviceBoundProbeArgv,
	checkConnectivityViaDevice,
	type DeviceBoundProbeDeps,
	PROBE_STATUS_MARKER,
	parseCurlProbeResponse,
} from "../modules/network/device-bound-probe.ts";
import {
	NETIF_ERR_DUPIPV4,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";

function iface(over: Partial<NetworkInterface> = {}): NetworkInterface {
	return {
		ip: "192.168.1.10",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
		...over,
	};
}

/**
 * The bench roster: the LAN port plus the two physically distinct HiLink twins,
 * both leasing 192.168.8.100 behind the same 192.168.8.1 gateway.
 */
const TWIN_NETIF: Record<string, NetworkInterface> = {
	eth0: iface({ ip: "192.168.78.132" }),
	enx0c5b8f279a64: iface({
		ip: "192.168.8.100",
		enabled: false,
		error: NETIF_ERR_DUPIPV4,
	}),
	eth1: iface({
		ip: "192.168.8.100",
		enabled: false,
		error: NETIF_ERR_DUPIPV4,
	}),
};

/** The externally-resolved connectivity-check addresses (www.gstatic.com A). */
const EXTERNAL_ADDRS = ["142.251.133.99"];

/** The address BOTH twins' embedded admin UIs answer on. Never a probe target. */
const TWIN_ADMIN_GATEWAY = "192.168.8.1";

// ─── 1. Binding ──────────────────────────────────────────────────────────────

describe("buildDeviceBoundProbeArgv", () => {
	test("the interface is its own argv element, never interpolated", () => {
		const argv = buildDeviceBoundProbeArgv("142.251.133.99", "eth1");
		const at = argv.indexOf("--interface");
		expect(at).toBeGreaterThan(-1);
		expect(argv[at + 1]).toBe("eth1");
	});

	test("the destination is the external check URL, not a gateway", () => {
		const argv = buildDeviceBoundProbeArgv("142.251.133.99", "eth1");
		expect(argv.at(-1)).toBe("http://142.251.133.99/generate_204");
		expect(argv.join(" ")).not.toContain(TWIN_ADMIN_GATEWAY);
	});

	test("an IPv6 literal is bracketed so the URL parses", () => {
		const argv = buildDeviceBoundProbeArgv("2a00:1450:4001:80f::2003", "eth1");
		expect(argv.at(-1)).toBe("http://[2a00:1450:4001:80f::2003]/generate_204");
	});

	test("the twins produce two DIFFERENT argvs from one address", () => {
		const a = buildDeviceBoundProbeArgv("142.251.133.99", "enx0c5b8f279a64");
		const b = buildDeviceBoundProbeArgv("142.251.133.99", "eth1");
		expect(a).not.toEqual(b);
	});

	test("a suspect interface name is refused before it reaches argv", () => {
		for (const bad of ["--upload-file", "eth1;rm -rf /", "", "a".repeat(16)]) {
			expect(() => buildDeviceBoundProbeArgv("1.2.3.4", bad)).toThrow();
		}
	});
});

// ─── 2. Response contract ────────────────────────────────────────────────────

describe("parseCurlProbeResponse", () => {
	test("a clean 204 carries no body", () => {
		expect(parseCurlProbeResponse(`${PROBE_STATUS_MARKER}204`)).toEqual({
			code: 204,
			body: "",
		});
	});

	test("a captive-portal answer keeps its body and its real code", () => {
		const portal = `<html><body>\nRedirecting</body></html>${PROBE_STATUS_MARKER}307`;
		expect(parseCurlProbeResponse(portal)).toEqual({
			code: 307,
			body: "<html><body>\nRedirecting</body></html>",
		});
	});

	test("a killed transfer has no marker and is not mistaken for success", () => {
		expect(parseCurlProbeResponse("")).toEqual({ code: 0, body: "" });
	});
});

describe("checkConnectivityViaDevice", () => {
	function deps(stdout: string): DeviceBoundProbeDeps & {
		spy: ReturnType<typeof mock>;
	} {
		const spy = mock(async () => ({ exitCode: 0, stdout, stderr: "" }));
		return { runProbe: spy, shouldUseMocks: () => false, spy };
	}

	test("only an exact 204 + empty body is reachable", async () => {
		const ok = deps(`${PROBE_STATUS_MARKER}204`);
		expect(await checkConnectivityViaDevice("1.2.3.4", "eth1", ok)).toBe(true);

		const portal = deps(`<html>portal</html>${PROBE_STATUS_MARKER}307`);
		expect(await checkConnectivityViaDevice("1.2.3.4", "eth1", portal)).toBe(
			false,
		);

		// A 204 that somehow carried a body is an injected answer, not gstatic's.
		const bodied = deps(`unexpected${PROBE_STATUS_MARKER}204`);
		expect(await checkConnectivityViaDevice("1.2.3.4", "eth1", bodied)).toBe(
			false,
		);
	});

	test("a missing or hung curl resolves false, never throws", async () => {
		const thrown: DeviceBoundProbeDeps = {
			runProbe: async () => {
				throw new Error("curl: command not found");
			},
			shouldUseMocks: () => false,
		};
		expect(await checkConnectivityViaDevice("1.2.3.4", "eth1", thrown)).toBe(
			false,
		);
	});

	test("a mock host answers without spawning anything", async () => {
		const spy = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
		expect(
			await checkConnectivityViaDevice("1.2.3.4", "eth1", {
				runProbe: spy,
				shouldUseMocks: () => true,
			}),
		).toBe(true);
		expect(spy).not.toHaveBeenCalled();
	});
});

// ─── 3. Election: independence + separation ──────────────────────────────────

type ProbeCalls = {
	device: Array<{ addr: string; ifname: string }>;
	sourceIp: Array<{ addr: string; ip: string }>;
};

function recordingProbes(
	reachableDevices: ReadonlySet<string>,
	reachableSourceIps: ReadonlySet<string> = new Set(),
): ConnectivityProbes & { calls: ProbeCalls } {
	const calls: ProbeCalls = { device: [], sourceIp: [] };
	return {
		calls,
		probeViaDevice: async (addr, ifname) => {
			calls.device.push({ addr, ifname });
			return reachableDevices.has(ifname);
		},
		probeViaSourceIp: async (addr, ip) => {
			calls.sourceIp.push({ addr, ip });
			return reachableSourceIps.has(ip);
		},
	};
}

/** The twins only, so the election has to separate them by device alone. */
function twinCandidates(): ProbeCandidate[] {
	return eligibleProbeCandidates(TWIN_NETIF).filter(
		(c) => c.binding.kind === "device",
	);
}

describe("electConnectivityCandidate — twin fixtures", () => {
	test("each twin is probed on its OWN physical interface", async () => {
		const probes = recordingProbes(new Set());
		await electConnectivityCandidate(EXTERNAL_ADDRS, twinCandidates(), probes);

		expect(probes.calls.device.map((c) => c.ifname)).toEqual([
			"enx0c5b8f279a64",
			"eth1",
		]);
		// Their shared address is never used to steer anything.
		expect(probes.calls.sourceIp).toEqual([]);
	});

	test("WAN down on ONE twin marks only that twin unreachable", async () => {
		const probes = recordingProbes(new Set(["eth1"]));
		const election = await electConnectivityCandidate(
			EXTERNAL_ADDRS,
			twinCandidates(),
			probes,
		);

		expect(election.elected?.name).toBe("eth1");
		expect(
			election.results.map((r) => [r.candidate.name, r.reachable]),
		).toEqual([
			["enx0c5b8f279a64", false],
			["eth1", true],
		]);
	});

	test("the failing twin's verdict does not contaminate its sibling", async () => {
		const first = await electConnectivityCandidate(
			EXTERNAL_ADDRS,
			twinCandidates(),
			recordingProbes(new Set(["eth1"])),
		);
		const second = await electConnectivityCandidate(
			EXTERNAL_ADDRS,
			twinCandidates(),
			recordingProbes(new Set(["enx0c5b8f279a64"])),
		);

		expect(first.elected?.name).toBe("eth1");
		expect(second.elected?.name).toBe("enx0c5b8f279a64");
	});

	test("both twins down elects nothing and still reports two verdicts", async () => {
		const election = await electConnectivityCandidate(
			EXTERNAL_ADDRS,
			twinCandidates(),
			recordingProbes(new Set()),
		);
		expect(election.elected).toBeUndefined();
		expect(election.results).toHaveLength(2);
	});
});

describe("admin reachability is NOT a WAN claim", () => {
	test("no probe ever targets the twins' shared admin gateway", async () => {
		const probes = recordingProbes(new Set(["eth1"]));
		await electConnectivityCandidate(
			EXTERNAL_ADDRS,
			eligibleProbeCandidates(TWIN_NETIF),
			probes,
		);

		const targets = [
			...probes.calls.device.map((c) => c.addr),
			...probes.calls.sourceIp.map((c) => c.addr),
		];
		expect(targets).not.toContain(TWIN_ADMIN_GATEWAY);
		expect(new Set(targets)).toEqual(new Set(EXTERNAL_ADDRS));
	});

	test("a twin whose admin gateway answers is still unreachable when its WAN is down", async () => {
		// The dongle answering 192.168.8.1 is modelled by it NOT being in the
		// reachable-device set: the only thing this election ever asks is whether
		// the EXTERNAL address answers through that device.
		const election = await electConnectivityCandidate(
			EXTERNAL_ADDRS,
			twinCandidates(),
			recordingProbes(new Set()),
		);
		expect(election.results.every((r) => !r.reachable)).toBe(true);
	});
});

describe("electConnectivityCandidate — ordinary roster is unchanged", () => {
	test("a normally-addressed interface is still probed by source address", async () => {
		const probes = recordingProbes(new Set(), new Set(["192.168.78.132"]));
		const election = await electConnectivityCandidate(
			EXTERNAL_ADDRS,
			eligibleProbeCandidates({ eth0: iface({ ip: "192.168.78.132" }) }),
			probes,
		);

		expect(election.elected?.name).toBe("eth0");
		expect(probes.calls.sourceIp).toEqual([
			{ addr: EXTERNAL_ADDRS[0] as string, ip: "192.168.78.132" },
		]);
		expect(probes.calls.device).toEqual([]);
	});

	test("every resolved address is tried before giving up", async () => {
		const probes = recordingProbes(new Set(), new Set());
		const election = await electConnectivityCandidate(
			["142.251.133.99", "142.251.133.100"],
			eligibleProbeCandidates({ eth0: iface({ ip: "192.168.78.132" }) }),
			probes,
		);

		expect(election.elected).toBeUndefined();
		expect(probes.calls.sourceIp.map((c) => c.addr)).toEqual([
			"142.251.133.99",
			"142.251.133.100",
		]);
	});
});
