import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UplinkShaperApplier } from "../modules/network/uplink-shaper/applier.ts";
import { UplinkShaperCoordinator } from "../modules/network/uplink-shaper/coordinator.ts";
import { readShaperOwnership } from "../modules/network/uplink-shaper/ownership-authority.ts";

test.each(["retained", "absent"] as const)(
	"backend restart applies %s roots on the first idle tick only",
	async (state) => {
		// Given a new coordinator after restart, independent of any streaming/sharing edge.
		const root = mkdtempSync(join(tmpdir(), "shaper-boot-"));
		const path = join(root, "roots.json");
		if (state === "retained")
			writeFileSync(path, '{"eth0":{"kind":"noqueue","handle":"0:"}}');
		let reads = 0;
		const commands: string[][] = [];
		const applier = new UplinkShaperApplier({
			readRecordedRoots: async () => {
				reads++;
				return readShaperOwnership(path);
			},
			writeRecordedRoots: async (roots) => {
				writeFileSync(path, JSON.stringify(roots));
			},
			readRoot: async () => ({ kind: "noqueue", handle: "0:" }),
			readBacklog: async () => 0,
			runTc: async (argv) => {
				commands.push([...argv]);
			},
		});
		const coordinator = new UplinkShaperCoordinator({
			apply: (request) => applier.apply(request),
		});
		try {
			// When the first idle tick runs with no shared uplinks.
			await coordinator.update({
				streaming: false,
				sharedUplinks: [],
				telemetry: [],
			});
			// Then retained roots are restored and empty ownership incurs no tc command.
			expect(reads).toBe(1);
			expect(commands).toEqual(
				state === "retained" ? [["qdisc", "del", "dev", "eth0", "root"]] : [],
			);
			expect(readFileSync(path, "utf8")).toBe("{}");
			await coordinator.update({
				streaming: false,
				sharedUplinks: [],
				telemetry: [],
			});
			await coordinator.update({
				streaming: false,
				sharedUplinks: [],
				telemetry: [],
			});
			expect(reads).toBe(1);
			expect(commands).toEqual(
				state === "retained" ? [["qdisc", "del", "dev", "eth0", "root"]] : [],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
