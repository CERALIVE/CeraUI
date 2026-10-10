import { expect, test } from "bun:test";
import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import { electConnectivityCandidate } from "../modules/network/connectivity-election.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";

const candidates: readonly ProbeCandidate[] = [
	"eth0",
	"wlan0",
	"modem0",
	"twin0",
	"twin1",
].map((name) => ({
	name,
	ip: "192.0.2.2",
	binding: { kind: "device", ifname: name },
}));

test("a five-uplink sweep starts independent repository probes after its first candidate fails", async () => {
	// Given: the default fails and remaining probes wait on a completion barrier.
	const barrier = Promise.withResolvers<void>();
	const poolStarted = Promise.withResolvers<void>();
	const started: string[] = [];
	const election = electConnectivityCandidate([], candidates, {
		probeRepository: async (name) => {
			started.push(name);
			if (name === "eth0") return deriveVerdict([]);
			if (started.length === candidates.length) poolStarted.resolve();
			await barrier.promise;
			return deriveVerdict([]);
		},
		probeViaDevice: async () => false,
		probeViaSourceIp: async () => false,
	});
	try {
		// When: the remaining candidates have started but not completed.
		await poolStarted.promise;
		expect(started).toEqual(candidates.map((candidate) => candidate.name));
	} finally {
		barrier.resolve();
		await election;
	}
	// Then: every result retains its input identity and record-order ranking.
	expect(
		(await election).results.map((result) => result.candidate.name),
	).toEqual(started);
});

test("concurrent completion order cannot elect a later equally healthy uplink", async () => {
	// Given: default failed, and the first remaining healthy uplink is slower.
	const barrier = Promise.withResolvers<void>();
	const completed: string[] = [];
	const election = electConnectivityCandidate([], candidates, {
		probeRepository: async (name) => {
			if (name === "eth0") return deriveVerdict([]);
			if (name === "wlan0") await barrier.promise;
			completed.push(name);
			return deriveVerdict([
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
		},
		probeViaDevice: async () => false,
		probeViaSourceIp: async () => false,
	});
	try {
		// When: the later candidate has already completed but the earlier one has not.
		for (let turn = 0; turn < 16; turn++) await Promise.resolve();
		expect(completed).toContain("modem0");
		expect(completed).not.toContain("wlan0");
	} finally {
		barrier.resolve();
		await election;
	}
	// Then: latency does not replace the established record-order tie breaker.
	expect((await election).elected?.name).toBe("wlan0");
});

test("a 128-uplink failed-default sweep bounds concurrency and retains input order", async () => {
	// Given: an arbitrarily large roster and controlled completion barriers.
	const names = Array.from({ length: 128 }, (_, index) => `uplink${index}`);
	const inputs: readonly ProbeCandidate[] = names.map((name) => ({
		name,
		ip: "192.0.2.2",
		binding: { kind: "device", ifname: name },
	}));
	const entered = Promise.withResolvers<void>();
	const drain = Promise.withResolvers<void>();
	let active = 0;
	let peak = 0;
	const flight = electConnectivityCandidate([], inputs, {
		probeRepository: async (name) => {
			if (name === "uplink0") return deriveVerdict([]);
			active++;
			peak = Math.max(active, peak);
			if (active === 4) entered.resolve();
			await drain.promise;
			active--;
			return deriveVerdict([]);
		},
		probeViaDevice: async () => false,
		probeViaSourceIp: async () => false,
	});
	try {
		// When: the pool is full before any delayed observation completes.
		await entered.promise;
		expect(active).toBe(4);
	} finally {
		drain.resolve();
	}
	// Then: the hard ceiling holds throughout and every submitted identity drains.
	const result = await flight;
	expect(peak).toBeLessThanOrEqual(4);
	expect(active).toBe(0);
	expect(result.results.map((result) => result.candidate.name)).toEqual(names);
});
