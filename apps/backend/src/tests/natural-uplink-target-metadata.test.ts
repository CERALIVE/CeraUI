import { expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import { NaturalUplinkRecovery } from "../modules/network/natural-uplink-recovery.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

test("recovery identity survives target-shaped realm erasure", async () => {
	// Given: identical route paths with retained host metadata and erased target metadata.
	const rows = [
		"default dev routeb proto 242 metric 49",
		"default dev routea proto 16 metric 50 realm 7",
		"default dev routeb proto 16 metric 600",
	];
	const host = new DefaultRouteTable(rows, [], "host");
	const board = new DefaultRouteTable(rows, [], "board");
	let erased = false;
	const runner: typeof run = (bin, args) =>
		(erased ? board : host).runner(bin, args);
	const recovery = new NaturalUplinkRecovery(runner);
	const candidates: readonly ProbeCandidate[] = [
		{
			name: "routea",
			ip: "192.0.2.2",
			binding: { kind: "device", ifname: "routea" },
		},
	];
	const probes = {
		probeRepository: async () =>
			deriveVerdict([
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
			]),
		probeViaDevice: async () => false,
		probeViaSourceIp: async () => false,
	};
	expect(host.rows().some((row) => row.includes("realm 7"))).toBe(true);
	expect(board.rows().some((row) => /realm|classid/.test(row))).toBe(false);
	await recovery.ready(candidates, probes, () => 1_000);
	await recovery.ready(candidates, probes, () => 6_000);
	// When: the otherwise identical kernel projection drops legacy metadata.
	erased = true;
	const ready = await recovery.ready(candidates, probes, () => 11_000);
	// Then: the recovery streak survives without any observer mutation.
	expect(ready).toBe(true);
	expect(host.mutations).toEqual([]);
	expect(board.mutations).toEqual([]);
});
