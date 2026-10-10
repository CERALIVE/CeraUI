import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type OsStageReceipt,
	readStagedReceiptEvidence,
} from "../modules/system/update-orchestrator/os-agent.ts";
import { retireStagedReceipt } from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	cleanupRecovery,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";

const installedImage = {
	slot: "rootfs.0",
	bundleHash: "a".repeat(64),
	checksum: "b".repeat(64),
	installedAt: "2026-10-08T12:54:01Z",
	installedCount: 7,
};
const bootId = "29dd9a67-91db-412a-8729-accdb5825369";
const receipt: OsStageReceipt = {
	schema: 1,
	version: "2026.10.64",
	channel: "drill",
	stagedAt: 1791464043236,
	bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
	installedImage,
};
const dirs: string[] = [];
afterEach(() => {
	cleanupRecovery();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("Check keeps the receipt when local failed memory trails authoritative os-verifying", async () => {
	// Given real receipt/agent files and stale local failed memory.
	const dir = mkdtempSync("/var/tmp/ceraui-receipt-runtime-");
	dirs.push(dir);
	const bytes = JSON.stringify(receipt);
	let diskAuthority = false;
	await recoveryHarness({
		readPersistedState: async () =>
			diskAuthority
				? loadOrchestratorState(join(dir, "agent.json"))
				: structuredClone(getOrchestratorState()),
		readOsReceipt: async () =>
			existsSync(join(dir, "os-staged.json")) ? receipt : undefined,
		readOsReceiptEvidence: () => readStagedReceiptEvidence(dir),
		readBootedVersion: async () => receipt.version,
		readBootId: async () => bootId,
		readBootedImage: async () => installedImage,
		readHealthyState: async () => ({
			boot_id: bootId,
			slot: "A",
			build_id: "b",
			dpkg_status_sha256: "d".repeat(64),
			recorded_at: "2026-10-09T10:00:00Z",
		}),
		readActivationArmed: async () => false,
		inspectOsOperation: async () => "idle",
		proveOsWriterQuiescent: async () => true,
		retireOsReceipt: (judged) => retireStagedReceipt(judged, dir),
		acknowledgeOsReceipt: () => undefined,
	});
	setOrchestratorStateForTest({
		...getOrchestratorState(),
		phase: "failed",
		failureReason: "rauc_recovery_unproven",
	});
	saveOrchestratorState(
		{ ...getOrchestratorState(), phase: "os-verifying", failureReason: null },
		join(dir, "agent.json"),
	);
	writeFileSync(join(dir, "os-staged.json"), bytes);
	diskAuthority = true;
	// When production Check reaches receipt retirement before recovery settlement.
	const result = await checkUpdatesNow();
	// Then Check stays busy without stealing the verifier's receipt.
	expect(result).toEqual({ started: false, reason: "busy" });
	expect(readFileSync(join(dir, "os-staged.json"), "utf8")).toBe(bytes);
});
