import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgedOsReceipt } from "../modules/system/update-orchestrator/os-agent.ts";
import {
	retireConsumedStagedReceipt,
	retireStagedReceipt,
} from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { receiptJudgment } from "./helpers/os-receipt-judgment.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

const installedImage = {
	slot: "rootfs.0",
	bundleHash: "a".repeat(64),
	checksum: "b".repeat(64),
	installedAt: "2026-10-08T12:54:01Z",
	installedCount: 7,
};
const receipt = {
	schema: 1 as const,
	version: "2026.10.68",
	channel: "drill" as const,
	stagedAt: 1791464043236,
	bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
	installedImage,
};
const bootId = "29dd9a67-91db-412a-8729-accdb5825369";
const local: OrchestratorState = {
	...initialOrchestratorState(0),
	phase: "failed",
	failureReason: "rauc_recovery_unproven",
};
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test.each([
	"os-staging",
	"os-staged",
	"os-activation-armed",
	"os-verifying",
	"committing",
	"failed",
] as const)(
	"keeps the exact inode when persisted authority drifts to %s",
	async (phase) => {
		// Given stale failed memory and a different persisted authority.
		const dir = mkdtempSync("/var/tmp/ceraui-receipt-authority-");
		dirs.push(dir);
		const bytes = JSON.stringify(receipt);
		writeFileSync(join(dir, "os-staged.json"), bytes);
		const authoritative: OrchestratorState = {
			...local,
			phase,
			failureReason: "changed authority",
		};
		const port = {
			snapshot: () => ({
				state: local,
				phase: local.phase,
				activeAttemptId: null,
				generation: 1,
				producing: false,
			}),
			acquireControl: acquireTestOsStageControl,
			readPersisted: async () => authoritative,
			readReceipt: async () => receiptJudgment(receipt, dir),
			readBootedVersion: async () => receipt.version,
			readBootId: async () => bootId,
			readHealthyBootId: async () => bootId,
			readBootedImage: async () => installedImage,
			readActivationArmed: async () => false,
			inspectOperation: async () => "idle" as const,
			retire: (judged: JudgedOsReceipt) => retireStagedReceipt(judged, dir),
		};
		// When the production retirement controller acquires CONTROL.
		const retired = await retireConsumedStagedReceipt(port);
		// Then no receipt mutation is authorized by stale memory.
		expect(retired).toBe(false);
		expect(readFileSync(join(dir, "os-staged.json"), "utf8")).toBe(bytes);
	},
);
