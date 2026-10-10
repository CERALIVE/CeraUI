import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readReceiptFile } from "../modules/system/update-orchestrator/os-receipt-file-identity.ts";
import {
	readOsJobFile,
	writeOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { outcomesAbsent } from "../modules/system/update-orchestrator/os-stage-unlaunched-effects.ts";
import {
	readOsUnlaunchedWitness,
	writeOsUnlaunchedWitness,
} from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { record } from "./helpers/os-stage-orphan-record.ts";
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";

const bytes =
	'{"schema":1,"version":"2026.10.64","channel":"drill","stagedAt":1791464043236,"bootId":"070fd8ac-4a40-4b85-9d31-f21502ebd117"}';
const next = {
	...manifest,
	version: "2026.10.68",
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
};

test.each(["unchanged", "replaced", "created", "launched", "legacy"] as const)(
	"never-launched settlement treats %s receipt conservatively",
	async (scenario) => {
		// Given an actual admission receipt baseline in the private durable job record.
		const dir = mkdtempSync("/var/tmp/ceraui-baseline-physical-");
		const live = join(dir, "os-staged.json");
		if (scenario !== "created") writeFileSync(live, bytes);
		const baseline = readReceiptFile(dir)?.identity ?? null;
		await using h = await unlaunchedHarness("live", {
			candidateKey: JSON.stringify(next),
			baseline: { ...record.baseline, bootId: input.bootId },
		});
		writeOsStageJob(
			{
				...h.job,
				launched: scenario === "launched",
				...(scenario === "legacy" ? {} : { receiptBaseline: baseline }),
			},
			h.directory,
		);
		if (scenario === "replaced" || scenario === "created") {
			writeFileSync(join(dir, "replacement"), bytes);
			renameSync(join(dir, "replacement"), live);
		}
		const witnessDeps = { path: join(dir, "witness.json"), uid: h.uid };
		const settle = () =>
			h.settle({
				outcomesAbsent: (job) => outcomesAbsent(job, dir),
				witness: (value) => {
					writeOsUnlaunchedWitness(value, witnessDeps);
					h.effects.push("witness");
				},
			});
		// When real private-file settlement attempts to release this guardian.
		if (scenario === "unchanged") {
			await settle();
			// Then unchanged legacy evidence is inert, preserved, and bound into the durable witness.
			expect(h.effects).toContain("normal-exit");
			expect(readOsUnlaunchedWitness(witnessDeps)?.receiptBaseline).toEqual(
				baseline,
			);
			expect(existsSync(join(dir, "os-staged.consumed.json"))).toBe(false);
		} else {
			await expect(settle()).rejects.toHaveProperty(
				"reason",
				"rauc_recovery_unproven",
			);
			expect(h.effects).toEqual([]);
			expect(await readOsJobFile("release", h.directory, h.uid)).toBeNull();
			expect(readOsUnlaunchedWitness(witnessDeps)).toBeNull();
		}
		expect(readFileSync(live, "utf8")).toBe(bytes);
	},
);
