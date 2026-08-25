import { describe, expect, test } from "bun:test";

import {
	type ShaperApplyRequest,
	ShaperUnavailableError,
	UplinkShaperApplier,
} from "../modules/network/uplink-shaper/index.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";

const request: ShaperApplyRequest = {
	mode: "streaming",
	uplinks: [
		{ ifname: "wwan0", mark: stableUplinkMark("a"), capBps: 4_000_000 },
	],
};

describe("qdisc ownership", () => {
	test.each(["mq", "fq_codel", "noqueue", "pfifo_fast"])(
		"takes over recognized %s and records it",
		async (kind) => {
			const log: string[] = [];
			const applier = new UplinkShaperApplier({
				readRoot: async () => ({ kind, handle: "0:" }),
				runTc: async (argv) => log.push(argv.join(" ")),
				readBacklog: async () => 0,
			});

			await applier.apply(request);

			expect(applier.recordedRoots()).toEqual({
				wwan0: { kind, handle: "0:" },
			});
			expect(log.length).toBeGreaterThan(0);
		},
	);

	test("reapplies an already-owned root idempotently by reserved handle", async () => {
		const log: string[] = [];
		const applier = new UplinkShaperApplier({
			readRoot: async () => ({ kind: "prio", handle: "ca00:" }),
			runTc: async (argv) => log.push(argv.join(" ")),
			readBacklog: async () => 0,
		});
		await applier.apply(request);
		await applier.apply(request);
		expect(
			log.filter((line) =>
				line.includes("qdisc replace dev wwan0 root handle ca00:"),
			),
		).toHaveLength(2);
	});

	test("backend restart reloads the recorded default before reconciling its owned handle", async () => {
		const log: string[] = [];
		const applier = new UplinkShaperApplier({
			readRoot: async () => ({ kind: "prio", handle: "ca00:" }),
			runTc: async (argv) => log.push(argv.join(" ")),
			readBacklog: async () => 0,
			readRecordedRoots: async () => ({ wwan0: { kind: "mq", handle: "0:" } }),
		});
		await applier.apply(request);
		expect(applier.recordedRoots()).toEqual({
			wwan0: { kind: "mq", handle: "0:" },
		});
		await applier.teardown();
		expect(log.at(-1)).toBe("qdisc replace dev wwan0 root mq");
	});

	test("refuses an unrecognized custom root before any tc mutation", async () => {
		const log: string[] = [];
		const applier = new UplinkShaperApplier({
			readRoot: async () => ({ kind: "tbf", handle: "1:" }),
			runTc: async (argv) => log.push(argv.join(" ")),
			readBacklog: async () => 0,
		});

		await expect(applier.apply(request)).rejects.toBeInstanceOf(
			ShaperUnavailableError,
		);
		expect(log).toEqual([]);
	});

	test("tc failures become typed shaper_unavailable after the automatic fallback", async () => {
		const applier = new UplinkShaperApplier({
			readRoot: async () => ({ kind: "fq_codel", handle: "0:" }),
			runTc: async () => {
				throw new Error("tc refused");
			},
			readBacklog: async () => 0,
		});

		await expect(applier.apply(request)).rejects.toMatchObject({
			reason: "tc_apply_failed",
		});
	});

	test("a failed CAKE child probe automatically reports the HTB fallback", async () => {
		const log: string[] = [];
		const applier = new UplinkShaperApplier({
			readRoot: async () => ({ kind: "fq_codel", handle: "0:" }),
			runTc: async (argv) => {
				const line = argv.join(" ");
				log.push(line);
				if (line.includes(" cake ")) throw new Error("sch_cake unavailable");
			},
			readBacklog: async () => 0,
		});

		expect(await applier.apply(request)).toBe("htb-fq_codel");
		expect(log.some((line) => line.includes(" htb "))).toBe(true);
	});

	test("teardown restores every recorded root in sequence", async () => {
		const log: string[] = [];
		const applier = new UplinkShaperApplier({
			readRoot: async (ifname) => ({
				kind: ifname === "wwan0" ? "fq_codel" : "mq",
				handle: "0:",
			}),
			runTc: async (argv) => log.push(argv.join(" ")),
			readBacklog: async () => 0,
		});
		await applier.apply({
			...request,
			uplinks: [
				...request.uplinks,
				{ ifname: "eth0", mark: stableUplinkMark("b"), capBps: 4_000_000 },
			],
		});
		log.length = 0;
		await applier.teardown();
		expect(log).toEqual([
			"qdisc replace dev eth0 root mq",
			"qdisc replace dev wwan0 root fq_codel",
		]);
	});
});
