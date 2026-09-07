import { afterEach, describe, expect, jest, test } from "bun:test";

import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import {
	type ConnectivityProbes,
	electConnectivityCandidate,
	raceConnectivityAddresses,
} from "../modules/network/connectivity-election.ts";

const IPV4_TARGET = "142.251.133.99";
const IPV6_TARGETS = [
	"2a00:1450:4001:80f::2003",
	"2a00:1450:4001:80f::2004",
] as const;
const IPV4_CANDIDATE: ProbeCandidate = {
	name: "eth0",
	ip: "192.168.78.132",
	binding: { kind: "source-ip", ip: "192.168.78.132" },
};

afterEach(() => {
	jest.useRealTimers();
});

async function settleWithFakeTime<T>(pending: Promise<T>): Promise<{
	readonly elapsedMs: number;
	readonly value: T;
}> {
	let settled: { readonly value: T } | undefined;
	void pending.then((value) => {
		settled = { value };
	});

	for (let elapsedMs = 0; elapsedMs <= 10_000; elapsedMs += 250) {
		await Promise.resolve();
		if (settled) return { elapsedMs, value: settled.value };
		jest.advanceTimersByTime(250);
	}

	throw new Error("connectivity election did not settle inside the test bound");
}

describe("gateway connectivity family race", () => {
	test("Rock topology reaches IPv4 without walking two hanging AAAA targets", async () => {
		// Given: stale cached ordering from the Rock, where IPv6 has no usable route.
		jest.useFakeTimers();
		const probes: ConnectivityProbes = {
			probeViaDevice: async () => false,
			probeViaSourceIp: async (addr) => {
				if (addr === IPV4_TARGET) return true;
				await new Promise((resolve) => setTimeout(resolve, 4_000));
				return false;
			},
		};

		// When: the candidate is checked against the complete dual-family result.
		const outcome = await settleWithFakeTime(
			electConnectivityCandidate(
				[...IPV6_TARGETS, IPV4_TARGET],
				[IPV4_CANDIDATE],
				probes,
			),
		);

		// Then: working IPv4 wins before a false offline verdict can be reached.
		expect(outcome.value.elected?.name).toBe("eth0");
		expect(outcome.elapsedMs).toBeLessThan(4_500);
	});

	test("an immediate IPv4 no-route result falls through to working IPv6", async () => {
		// Given: IPv4 cannot route and IPv6 serves the connectivity response.
		jest.useFakeTimers();
		const calls: string[] = [];

		// When: the unbound default-route probe races both families.
		const outcome = await settleWithFakeTime(
			raceConnectivityAddresses(
				[IPV4_TARGET, IPV6_TARGETS[0]],
				async (addr) => {
					calls.push(addr);
					return addr === IPV6_TARGETS[0];
				},
			),
		);

		// Then: IPv6 starts after the stagger and establishes reachability.
		expect(outcome.value).toBe(true);
		expect(outcome.elapsedMs).toBe(250);
		expect(calls).toEqual([IPV4_TARGET, IPV6_TARGETS[0]]);
	});

	test("two dead families preserve the unreachable verdict within one probe budget", async () => {
		// Given: the first address in each family hangs for the existing four seconds.
		jest.useFakeTimers();

		// When: the unbound default-route probe races those failures.
		const outcome = await settleWithFakeTime(
			raceConnectivityAddresses([IPV4_TARGET, IPV6_TARGETS[0]], async () => {
				await new Promise((resolve) => setTimeout(resolve, 4_000));
				return false;
			}),
		);

		// Then: the result remains unreachable and includes only the 250 ms stagger.
		expect(outcome.value).toBe(false);
		expect(outcome.elapsedMs).toBe(4_250);
		expect(outcome.elapsedMs).toBeLessThan(4_500);
	});

	test("a source-address binding skips targets from the other family", async () => {
		// Given: an IPv4 candidate and a dual-family target list.
		jest.useFakeTimers();
		const calls: string[] = [];
		const probes: ConnectivityProbes = {
			probeViaDevice: async () => false,
			probeViaSourceIp: async (addr) => {
				calls.push(addr);
				return addr === IPV4_TARGET;
			},
		};

		// When: candidate election probes through its explicit local address.
		const election = await electConnectivityCandidate(
			[IPV6_TARGETS[0], IPV4_TARGET],
			[IPV4_CANDIDATE],
			probes,
		);

		// Then: no IPv6 target is dialled from an IPv4 source address.
		expect(election.elected?.name).toBe("eth0");
		expect(calls).toEqual([IPV4_TARGET]);
	});

	test("a device-bound probe retains both families because curl binds only the interface", async () => {
		// Given: a device-bound candidate whose IPv6 path is the working one.
		jest.useFakeTimers();
		const calls: string[] = [];
		const candidate: ProbeCandidate = {
			name: "eth1",
			ip: "192.168.8.100",
			binding: { kind: "device", ifname: "eth1" },
		};
		const probes: ConnectivityProbes = {
			probeViaSourceIp: async () => false,
			probeViaDevice: async (addr) => {
				calls.push(addr);
				return addr === IPV6_TARGETS[0];
			},
		};

		// When: the interface-bound candidate is elected.
		const outcome = await settleWithFakeTime(
			electConnectivityCandidate(
				[IPV4_TARGET, IPV6_TARGETS[0]],
				[candidate],
				probes,
			),
		);

		// Then: both targets reach curl and IPv6 wins after the stagger.
		expect(outcome.value.elected?.name).toBe("eth1");
		expect(outcome.elapsedMs).toBe(250);
		expect(calls).toEqual([IPV4_TARGET, IPV6_TARGETS[0]]);
	});
});
