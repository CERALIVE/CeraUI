import { afterEach, describe, expect, test } from "bun:test";

import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import { electConnectivityCandidate } from "../modules/network/connectivity-election.ts";
import {
	type AptReachabilityDeps,
	probeAptReachability,
	resetAptReachabilityCacheForTest,
} from "../modules/system/apt-reachability.ts";

const SOURCES = "URIs: https://packages.example.test/repo\nSuites: stable";
const FIRST: ProbeCandidate = {
	name: "uplink-a",
	ip: "192.0.2.2",
	binding: { kind: "source-ip", ip: "192.0.2.2" },
};
const SECOND: ProbeCandidate = {
	name: "uplink-b",
	ip: "198.51.100.2",
	binding: { kind: "source-ip", ip: "198.51.100.2" },
};

afterEach(resetAptReachabilityCacheForTest);

function repositoryFixture(working: string | undefined) {
	const calls: string[][] = [];
	const deps: AptReachabilityDeps = {
		readSources: async () => SOURCES,
		runProbe: async (argv) => {
			calls.push(argv);
			const binding = argv[argv.indexOf("--interface") + 1];
			return argv.includes("-4") && binding === `if!${working}`
				? { exitCode: 0, stdout: "200 " }
				: { exitCode: 35, stdout: "000 " };
		},
	};
	return {
		calls,
		probeRepository: (ifname: string) =>
			probeAptReachability({ ...deps, ifname }),
		// Both NICs answer ordinary HTTP, including the TLS-resetting candidate.
		probeViaDevice: async () => true,
		probeViaSourceIp: async () => true,
	};
}

describe("repository-aware host election", () => {
	test("an HTTP-healthy candidate with reset repository TLS loses to verified TLS", async () => {
		// Given: the first NIC passes HTTP but curl reports TLS failure on it.
		const probes = repositoryFixture(SECOND.name);
		// When: the real election composes the real repository probe.
		const result = await electConnectivityCandidate(
			["203.0.113.10"],
			[FIRST, SECOND],
			probes,
		);
		// Then: record order cannot elect the TLS-impaired NIC.
		expect(result.elected?.name).toBe(SECOND.name);
		expect(probes.calls).toHaveLength(4);
		expect(
			probes.calls.every(
				(argv) =>
					argv.at(-1) ===
					"https://packages.example.test/repo/dists/stable/InRelease",
			),
		).toBe(true);
	});

	test("the only HTTP-healthy uplink remains electable when repository TLS fails", async () => {
		// Given: no alternative to the TLS-impaired NIC exists.
		const probes = repositoryFixture(undefined);
		// When: repository ranking has no passing candidate.
		const result = await electConnectivityCandidate(
			["203.0.113.10"],
			[FIRST],
			probes,
		);
		// Then: fallback preserves host reachability, without fabricating TLS success.
		expect(result.elected?.name).toBe(FIRST.name);
		expect(result.results[0]?.repository?.verdict).toBe("unreachable");
	});

	test("verified repository TLS does not depend on the generic HTTP endpoint", async () => {
		// Given: repository HTTPS works while the generic connectivity site is blocked.
		const probes = {
			...repositoryFixture(SECOND.name),
			probeViaDevice: async () => false,
			probeViaSourceIp: async () => false,
		};
		// When: there are no usable generic probe addresses either.
		const result = await electConnectivityCandidate(
			[],
			[FIRST, SECOND],
			probes,
		);
		// Then: repository evidence is sufficient to elect the working NIC.
		expect(result.elected?.name).toBe(SECOND.name);
	});
});

describe("device-bound repository probe", () => {
	test("each candidate probes configured origins over HTTPS and both families", async () => {
		// Given: a legacy HTTP source, not a generic connectivity endpoint.
		const calls: string[][] = [];
		const deps = {
			ifname: FIRST.name,
			readSources: async () => SOURCES.replace("https:", "http:"),
			runProbe: async (argv: string[]) => {
				calls.push(argv);
				return { exitCode: 0, stdout: "403 " };
			},
		};
		// When: the per-device probe runs.
		const result = await probeAptReachability(deps);
		// Then: TLS and device identity survive into the actual runner's argv.
		expect(result.verdict).toBe("any");
		expect(calls.map((argv) => (argv.includes("-4") ? 4 : 6))).toEqual([4, 6]);
		for (const argv of calls) {
			expect(
				argv.slice(
					argv.indexOf("--interface"),
					argv.indexOf("--interface") + 2,
				),
			).toEqual(["--interface", `if!${FIRST.name}`]);
			expect(argv.at(-1)).toBe(
				"https://packages.example.test/repo/dists/stable/InRelease",
			);
			expect(argv).toContain("-I");
			expect(argv).not.toContain("-k");
			expect(argv).not.toContain("--insecure");
		}
	});

	test("a NIC verdict neither reuses nor overwrites the host cache", async () => {
		// Given: the unbound host cache says usable.
		const hostDeps = {
			readSources: async () => SOURCES,
			runProbe: async () => ({ exitCode: 0, stdout: "200 " }),
		};
		await probeAptReachability(hostDeps);
		const fixture = repositoryFixture(SECOND.name);
		// When: opposite candidate verdicts are requested within that TTL.
		const first = await fixture.probeRepository(FIRST.name);
		const second = await fixture.probeRepository(SECOND.name);
		const host = await probeAptReachability(hostDeps);
		// Then: no candidate or unbound result can masquerade as another's reading.
		expect(first.verdict).toBe("unreachable");
		expect(second.verdict).toBe("force_ipv4");
		expect(host.verdict).toBe("any");
		expect(fixture.calls).toHaveLength(4);
	});

	test("an invalid interface never degrades into an unbound successful probe", async () => {
		// Given: an invalid interface at the boundary and a runner that would succeed.
		let calls = 0;
		const deps = {
			ifname: "--upload-file",
			readSources: async () => SOURCES,
			runProbe: async () => {
				calls++;
				return { exitCode: 0, stdout: "200 " };
			},
		};
		// When: binding cannot be constructed.
		const result = await probeAptReachability(deps);
		// Then: no request is made and no usable path is claimed.
		expect(result.verdict).toBe("unreachable");
		expect(calls).toBe(0);
	});
});
