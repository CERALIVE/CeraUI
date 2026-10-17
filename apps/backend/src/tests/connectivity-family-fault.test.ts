import { expect, test } from "bun:test";
import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import {
	type ConnectivityAddressProbe,
	electConnectivityCandidate,
} from "../modules/network/connectivity-election.ts";
import {
	type GatewayElectionDeps,
	updateGw,
} from "../modules/network/gateways.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";

const targets = ["203.0.113.10", "2001:db8::10"] as const;
const candidate: ProbeCandidate = {
	name: "eth0",
	ip: "192.0.2.2",
	binding: { kind: "device", ifname: "eth0" },
};
const healthy = deriveVerdict([
	{
		origin: {
			url: "https://repository.test",
			host: "repository.test",
			scheme: "https",
			probeUrl: "https://repository.test",
		},
		ipv4: "ok",
		ipv6: "no_route",
	},
]);

function familyFault(ipv4Success: boolean) {
	const ipv6Started = Promise.withResolvers<void>();
	const ipv4Completed = Promise.withResolvers<void>();
	const releaseFault = Promise.withResolvers<void>();
	let active = 0;
	const probe: ConnectivityAddressProbe = async (addr) => {
		active++;
		try {
			if (addr === targets[0]) {
				await ipv6Started.promise;
				ipv4Completed.resolve();
				return ipv4Success;
			}
			ipv6Started.resolve();
			await releaseFault.promise;
			throw new Error("controlled IPv6 observer failure");
		} finally {
			active--;
		}
	};
	return { probe, ipv4Completed, releaseFault, active: () => active };
}

test("confirmed IPv4 elects the candidate after joining a throwing family sibling", async () => {
	// Given: IPv4 confirms success only after the IPv6 observation is submitted.
	const h = familyFault(true);
	let settled = false;
	const outcome = electConnectivityCandidate(targets, [candidate], {
		probeRepository: async () => deriveVerdict([]),
		probeViaDevice: h.probe,
		probeViaSourceIp: async () => false,
	}).then(
		(value) => {
			settled = true;
			return { value };
		},
		(error: unknown) => {
			settled = true;
			return { error };
		},
	);
	try {
		// When: IPv4 has finished but the already-submitted IPv6 sibling has not.
		await h.ipv4Completed.promise;
		for (let turn = 0; turn < 16; turn++) await Promise.resolve();
		expect(settled).toBe(false);
		expect(h.active()).toBe(1);
	} finally {
		h.releaseFault.resolve();
	}
	// Then: the joined fault cannot erase confirmed generic evidence.
	const result = await outcome;
	expect(h.active()).toBe(0);
	expect("value" in result).toBe(true);
	if ("value" in result) {
		expect(result.value.elected?.name).toBe("eth0");
		expect(result.value.results[0]?.reachable).toBe(true);
		expect(result.value.family).toBe(4);
		expect(result.value.results[0]?.repository.ipv4).toBe("unknown");
	}
});

function gatewayFixture(checkConnectivity: ConnectivityAddressProbe) {
	const observed: string[] = [];
	const installed: Array<readonly [string, number]> = [];
	let releases = 0;
	const deps: GatewayElectionDeps = {
		isRealDevice: async () => true,
		resolve: async () => ({ addrs: [...targets], fromCache: true }),
		validateDns: () => {},
		checkConnectivity,
		interfaces: () => ({
			eth0: { ip: "192.0.2.2", error: 0, enabled: true, tp: 0, txb: 0, rxb: 0 },
		}),
		eligible: () => true,
		defaultInterface: async () => "eth0",
		installRoute: async (name, family) => {
			installed.push([name, family]);
		},
		releaseRoutes: async () => {
			releases++;
		},
		probes: {
			probeRepository: async (name) => {
				observed.push(name);
				return healthy;
			},
			probeViaDevice: async () => false,
			probeViaSourceIp: async () => false,
		},
	};
	return { deps, observed, installed, releases: () => releases };
}

test.each([true, false])(
	"unbound family fault with IPv4 success=%s still observes repository candidates",
	async (success) => {
		// Given: an unbound sibling fault and a repository-healthy candidate.
		const fault = familyFault(success);
		const h = gatewayFixture(fault.probe);
		const outcome = updateGw(h.deps).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		// When: both submitted unbound families finish, one exceptionally.
		try {
			await fault.ipv4Completed.promise;
			for (let turn = 0; turn < 16; turn++) await Promise.resolve();
			expect(h.observed).toEqual([]);
		} finally {
			fault.releaseFault.resolve();
		}
		// Then: unknown or positive unbound evidence cannot abort candidate election.
		expect(await outcome).toEqual({ value: true });
		expect(fault.active()).toBe(0);
		expect(h.observed).toEqual(["eth0"]);
		expect(h.installed).toEqual([["eth0", 4]]);
	},
);

test("unsuccessful unbound observation fault cannot authorize empty-election release", async () => {
	// Given: no eligible candidate and unknown unbound evidence, not proven loss.
	const h = gatewayFixture(async () => {
		throw new Error("observer I/O failure");
	});
	// When: gateway maintenance finishes that observation without a winner.
	const outcome = await updateGw({ ...h.deps, interfaces: () => ({}) }).then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	// Then: the unknown result is a retryable refusal, never release authority.
	expect(outcome).toEqual({ value: false });
	expect(h.releases()).toBe(0);
});
