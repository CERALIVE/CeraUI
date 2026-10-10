import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitStagedManifest } from "../modules/system/update-orchestrator/os-agent.ts";
import {
	type ReceiptFileIdentity,
	readReceiptFile,
} from "../modules/system/update-orchestrator/os-receipt-file-identity.ts";
import type { OsStageControlLease } from "../modules/system/update-orchestrator/os-stage-control-lease.ts";
import { acquireOsOrphanLock } from "../modules/system/update-orchestrator/os-stage-orphan-lock.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

test("captures admission baseline under real CONTROL and publishes only while that lease remains held", async () => {
	// Given a real receipt/CONTROL lease and fixture installer, RAUC and owner observations.
	const dir = mkdtempSync("/var/tmp/ceraui-stage-baseline-admission-");
	writeFileSync(
		join(dir, "os-staged.json"),
		'{"schema":1,"version":"2026.10.64","channel":"drill","stagedAt":1791464043236,"bootId":"070fd8ac-4a40-4b85-9d31-f21502ebd117"}',
	);
	const expected = readReceiptFile(dir)?.identity;
	const acquire = () =>
		acquireOsOrphanLock({
			lock: join(dir, "control.lock"),
			helper: join(
				import.meta.dir,
				"../../../../deployment/ceralive-os-stage-guard",
			),
		});
	let lease: OsStageControlLease | undefined;
	let captured: ReceiptFileIdentity | null | undefined;
	const h = await harness();
	const receipt = {
		schema: 1 as const,
		version: manifest.version,
		channel: manifest.channel,
		stagedAt: 1791465043236,
		bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
	};
	// When the production runner records its job and reaches the synchronous receipt callback.
	await runOsStageJob(manifest, h.control, {
		...h.deps,
		acquireControl: async () => {
			lease = await acquire();
			return lease;
		},
		readReceiptBaseline: () => {
			expect(lease?.held()).toBe(true);
			return readReceiptFile(dir)?.identity ?? null;
		},
		owner: (job) => {
			captured = job.receiptBaseline;
			return h.deps.owner(job);
		},
		prepareReceipt: async () => {
			await expect(acquire()).rejects.toHaveProperty(
				"reason",
				"rauc_recovery_unproven",
			);
			return () => {
				expect(lease?.held()).toBe(true);
				commitStagedManifest(manifest, receipt, dir);
				return "receipt";
			};
		},
	});
	// Then the job carries the exact old identity and the actual writer publishes under exclusion.
	expect(captured).toEqual(expected);
	expect(JSON.parse(readFileSync(join(dir, "os-staged.json"), "utf8"))).toEqual(
		receipt,
	);
});
