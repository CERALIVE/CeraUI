import { expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import { electConnectivityCandidate } from "../modules/network/connectivity-election.ts";
import { updateGw } from "../modules/network/gateways.ts";
import { NaturalUplinkRecovery } from "../modules/network/natural-uplink-recovery.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";

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
const candidates: readonly ProbeCandidate[] = ["eth0", "wlan0", "hilink"].map(
	(name) => ({
		name,
		ip: "192.0.2.2",
		binding: { kind: "device", ifname: name },
	}),
);

test("an observer rejection cannot defeat a healthy first candidate", async () => {
	// Given: a healthy default beside an observer that throws unexpectedly.
	const started: string[] = [];
	// When: election observes the candidates.
	const result = await electConnectivityCandidate([], candidates, {
		probeRepository: async (name) => {
			started.push(name);
			if (name === "wlan0") throw new Error("observer I/O failure");
			return healthy;
		},
		probeViaDevice: async () => false,
		probeViaSourceIp: async () => false,
	});
	// Then: maintenance can still use the working default.
	expect(result.elected?.name).toBe("eth0");
});

test("UNKNOWN cannot release ownership when no candidate proves connectivity", async () => {
	// Given: an owned preference and an observer I/O failure, not proven loss.
	let releases = 0;
	// When: the coordinator completes an unknown election.
	const result = await updateGw({
		isRealDevice: async () => true,
		resolve: async () => ({ addrs: [], fromCache: true }),
		validateDns: () => {},
		checkConnectivity: async () => false,
		interfaces: () => ({
			eth0: { ip: "192.0.2.2", error: 0, enabled: true, tp: 0, txb: 0, rxb: 0 },
		}),
		eligible: () => true,
		defaultInterface: async () => "eth0",
		installRoute: async () => {},
		releaseRoutes: async () => {
			releases++;
		},
		probes: {
			probeRepository: async () => {
				throw new Error("observer I/O failure");
			},
			probeViaDevice: async () => false,
			probeViaSourceIp: async () => false,
		},
	});
	// Then: retry stays armed without interpreting UNKNOWN as a release signal.
	expect(result).toBe(false);
	expect(releases).toBe(0);
});

test("election joins a delayed sibling when another observer rejects", async () => {
	// Given: first failed, second throwing, third held at a completion barrier.
	const entered = Promise.withResolvers<void>();
	const drain = Promise.withResolvers<void>();
	let pending = 0;
	let settled = false;
	const election = electConnectivityCandidate([], candidates, {
		probeRepository: async (name) => {
			if (name === "eth0") return deriveVerdict([]);
			if (name === "wlan0") throw new Error("observer I/O failure");
			pending++;
			entered.resolve();
			await drain.promise;
			pending--;
			return healthy;
		},
		probeViaDevice: async () => false,
		probeViaSourceIp: async () => false,
	}).then(
		(value) => {
			settled = true;
			return value;
		},
		(error) => {
			settled = true;
			throw error;
		},
	);
	// Attach immediately so the baseline rejection is observed, not unhandled.
	const outcome = election.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	try {
		// When: the throwing sibling has completed but the delayed one has not.
		await entered.promise;
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
	} finally {
		drain.resolve();
	}
	// Then: no observation remains unjoined; UNKNOWN is not the healthy winner.
	const result = await outcome;
	expect(pending).toBe(0);
	expect("value" in result).toBe(true);
	if ("value" in result) {
		expect(result.value.elected?.name).toBe("hilink");
		expect(
			result.value.results.find((r) => r.candidate.name === "wlan0")?.repository
				.ipv4,
		).toBe("unknown");
	}
});

test("repository observation exceptions preserve the ordinary connectivity fallback", async () => {
	// Given: repository I/O fails, but independent generic HTTP succeeds.
	// When: election probes the single candidate.
	const result = await electConnectivityCandidate(
		["203.0.113.10"],
		candidates.slice(0, 1),
		{
			probeRepository: async () => {
				throw new Error("credential read failed");
			},
			probeViaDevice: async () => true,
			probeViaSourceIp: async () => false,
		},
	);
	// Then: generic reachability does not fabricate repository health.
	expect(result.elected?.name).toBe("eth0");
	expect(result.results[0]?.repository.ipv4).toBe("unknown");
});

test("natural recovery joins every tied winner and resets on UNKNOWN", async () => {
	// Given: two tied natural winners, one throwing and one delayed.
	const runner: typeof run = async (_bin, args) =>
		args.includes("-6")
			? ""
			: "default dev owned proto 242 metric 49\ndefault dev eth0 proto 16 metric 50\ndefault dev wlan0 proto 16 metric 50";
	const recovery = new NaturalUplinkRecovery(runner);
	const entered = Promise.withResolvers<void>();
	const drain = Promise.withResolvers<void>();
	let pending = 0;
	let settled = false;
	const observation = recovery
		.ready(
			candidates,
			{
				probeRepository: async (name) => {
					if (name === "eth0") throw new Error("observer I/O failure");
					pending++;
					entered.resolve();
					await drain.promise;
					pending--;
					return healthy;
				},
				probeViaDevice: async () => false,
				probeViaSourceIp: async () => false,
			},
			() => 11_000,
		)
		.then(
			(value) => {
				settled = true;
				return value;
			},
			(error) => {
				settled = true;
				throw error;
			},
		);
	const outcome = observation.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	try {
		// When: the exception has settled while its tied peer is still submitted.
		await entered.promise;
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
	} finally {
		drain.resolve();
	}
	// Then: UNKNOWN withholds release, without abandoning the peer or ownership.
	const result = await outcome;
	expect(result).toEqual({ value: false });
	expect(pending).toBe(0);
	expect(recovery.pending).toBe(true);
});
