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

test("a five-uplink sweep starts independent repository probes without serial timeout amplification", async () => {
	// Given: every repository probe waits on one controlled completion barrier.
	const barrier = Promise.withResolvers<void>();
	const started: string[] = [];
	const election = electConnectivityCandidate([], candidates, {
		probeRepository: async (name) => {
			started.push(name);
			await barrier.promise;
			return deriveVerdict([]);
		},
		probeViaDevice: async () => false,
		probeViaSourceIp: async () => false,
	});
	try {
		// When: no uplink's timeout has completed yet.
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
	// Given: the first uplink's repository response is deliberately slower.
	const barrier = Promise.withResolvers<void>();
	const completed: string[] = [];
	const election = electConnectivityCandidate([], candidates, {
		probeRepository: async (name) => {
			if (name === "eth0") await barrier.promise;
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
		expect(completed).toContain("wlan0");
		expect(completed).not.toContain("eth0");
	} finally {
		barrier.resolve();
		await election;
	}
	// Then: latency does not replace the established record-order tie breaker.
	expect((await election).elected?.name).toBe("eth0");
});
