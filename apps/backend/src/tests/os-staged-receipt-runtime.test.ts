import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { OsStageRecovery } from "@ceraui/rpc/schemas";
import {
	type OsStageReceipt,
	readStagedReceiptEvidence,
} from "../modules/system/update-orchestrator/os-agent.ts";
import {
	CONSUMED_RECEIPT_NAME,
	retireStagedReceipt,
} from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { RootSlotStatus } from "../modules/system/update-orchestrator/slot-status.ts";
import {
	cleanupRecovery,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";

const ROCK_BOOT = "29dd9a67-91db-412a-8729-accdb5825369";
const installedImage = {
	slot: "rootfs.0",
	bundleHash: "a".repeat(64),
	checksum: "b".repeat(64),
	installedAt: "2026-10-08T12:54:01Z",
	installedCount: 7,
};
const boundReceipt: OsStageReceipt = {
	schema: 1,
	version: "2026.10.64",
	channel: "drill",
	stagedAt: 1791464043236,
	bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
	installedImage,
};
const boundBytes = JSON.stringify(boundReceipt);
const dirs: string[] = [];
afterEach(() => {
	cleanupRecovery();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("runtime manual check on the Rock's failed record", () => {
	const record: OsStageRecovery = {
		candidateKey: "rock-68",
		activeAttemptId: null,
		failedRounds: 1,
		nextRetryAt: null,
		mode: "unsafe",
		reason: "rauc_recovery_unproven",
	};
	const slots = (other: "good" | "bad"): readonly RootSlotStatus[] => [
		{
			name: "rootfs.0",
			bootname: "A",
			state: "booted",
			bootStatus: "good",
			version: null,
			lastSyncedAt: null,
		},
		{
			name: "rootfs.1",
			bootname: "B",
			state: "inactive",
			bootStatus: other,
			version: null,
			lastSyncedAt: null,
		},
	];
	async function rockCheck(other: "good" | "bad") {
		const dir = mkdtempSync("/var/tmp/ceraui-receipt-runtime-bound-");
		dirs.push(dir);
		await recoveryHarness({
			readPersistedState: async () => structuredClone(getOrchestratorState()),
			inspectOsOperation: async () => "idle",
			proveOsWriterQuiescent: async () => true,
			readActivationArmed: async () => false,
			readOsReceipt: async () => {
				const file = Bun.file(join(dir, "os-staged.json"));
				if (!(await file.exists())) return undefined;
				if ((await file.text()) !== boundBytes)
					throw new Error("fixture receipt changed");
				return boundReceipt;
			},
			retireOsReceipt: (receipt) => retireStagedReceipt(receipt, dir),
			readOsReceiptEvidence: () => readStagedReceiptEvidence(dir),
			readBootId: async () => ROCK_BOOT,
			readBootedVersion: async () => "2026.10.64",
			readBootedImage: async () => installedImage,
			readHealthyState: async () => ({
				boot_id: ROCK_BOOT,
				slot: "A",
				build_id: "b",
				dpkg_status_sha256: "d".repeat(64),
				recorded_at: "2026-10-09T10:00:00Z",
			}),
			readRootSlots: async () => slots(other),
		});
		writeFileSync(join(dir, "os-staged.json"), boundBytes);
		setOrchestratorStateForTest({
			...getOrchestratorState(),
			phase: "failed",
			failureReason: record.reason,
			osStageRecovery: record,
		});
		await checkUpdatesNow();
		return dir;
	}
	test("retires the receipt but both-good slots still keep the unsafe record", async () => {
		const dir = await rockCheck("good");
		expect(existsSync(join(dir, "os-staged.json"))).toBe(false);
		expect(readFileSync(join(dir, CONSUMED_RECEIPT_NAME), "utf8")).toBe(
			boundBytes,
		);
		// A good inactive target may be an unrecorded stage: no settlement proof.
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().osStageRecovery?.mode).toBe("unsafe");
	});
	test("an otherwise settled failure is no longer held hostage by the receipt", async () => {
		await rockCheck("bad");
		expect(getOrchestratorState().phase).not.toBe("failed");
	});
});
