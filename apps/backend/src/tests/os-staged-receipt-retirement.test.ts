import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OsStageRecovery } from "@ceraui/rpc/schemas";
import type { OsStageReceipt } from "../modules/system/update-orchestrator/os-agent.ts";
import {
	CONSUMED_RECEIPT_NAME,
	type ReceiptRetirementPort,
	retireConsumedStagedReceipt,
	retireStagedReceipt,
	type StagedReceiptEvidence,
	stagedReceiptConsumed,
} from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { RootSlotStatus } from "../modules/system/update-orchestrator/slot-status.ts";
import { ORCHESTRATOR_PHASES } from "../modules/system/update-orchestrator/types.ts";
import {
	cleanupRecovery,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

// The Rock's retained receipt, byte-exact from R12 (acceptance.raw:43), and
// the boot it was read on: 2026.10.64 is the version that board now runs.
const ROCK_RECEIPT_BYTES =
	'{"schema":1,"version":"2026.10.64","channel":"drill","stagedAt":1791464043236,"bootId":"070fd8ac-4a40-4b85-9d31-f21502ebd117"}';
const rockReceipt: OsStageReceipt = JSON.parse(ROCK_RECEIPT_BYTES);
const ROCK_BOOT = "29dd9a67-91db-412a-8729-accdb5825369";

const rock: StagedReceiptEvidence = {
	receipt: rockReceipt,
	phase: "failed",
	activeAttemptId: null,
	bootedVersion: "2026.10.64",
	bootId: ROCK_BOOT,
	healthyBootId: ROCK_BOOT,
	activationArmed: false,
	raucOperation: "idle",
};

const dirs: string[] = [];
function stateDir(bytes?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-receipt-"));
	dirs.push(dir);
	if (bytes !== undefined) writeFileSync(join(dir, "os-staged.json"), bytes);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	cleanupRecovery();
});

describe("stagedReceiptConsumed", () => {
	test("the Rock's receipt of its running version is consumed", () => {
		expect(stagedReceiptConsumed(rock)).toBe(true);
	});

	test.each<readonly [string, Partial<StagedReceiptEvidence>]>([
		// A staged-not-activated candidate always names a different version.
		["a different, still-staged version", { bootedVersion: "2026.10.63" }],
		["an unknown booted version", { bootedVersion: undefined }],
		// A crash reboot that kept the arming rebinds the receipt to this boot.
		[
			"a receipt written or rebound on this boot",
			{ receipt: { ...rockReceipt, bootId: ROCK_BOOT } },
		],
		["a boot without its healthcheck verdict", { healthyBootId: null }],
		["an earlier boot's healthcheck", { healthyBootId: rockReceipt.bootId }],
		["an armed activation", { activationArmed: true }],
		["a running RAUC operation", { raucOperation: "running" }],
		[
			"an active attempt",
			{ activeAttemptId: "00000000-0000-4000-8000-000000000001" },
		],
	])("keeps it for %s", (_label, change) => {
		expect(stagedReceiptConsumed({ ...rock, ...change })).toBe(false);
	});

	test("keeps it in every phase that still owns a receipt", () => {
		const open = ORCHESTRATOR_PHASES.filter(
			(phase) => !stagedReceiptConsumed({ ...rock, phase }),
		);
		expect(open).toEqual([
			"os-staging",
			"os-staged",
			"os-activation-armed",
			"os-verifying",
		]);
	});
});

describe("retireStagedReceipt", () => {
	test("renames exactly the judged receipt, keeping its bytes", () => {
		const dir = stateDir(ROCK_RECEIPT_BYTES);
		expect(retireStagedReceipt(rockReceipt, dir)).toBe(true);
		expect(existsSync(join(dir, "os-staged.json"))).toBe(false);
		expect(readFileSync(join(dir, CONSUMED_RECEIPT_NAME), "utf8")).toBe(
			ROCK_RECEIPT_BYTES,
		);
	});

	test("leaves a receipt that changed after it was judged", () => {
		// Given a fresh stage replaced the judged receipt.
		const fresh = JSON.stringify({
			...rockReceipt,
			version: "2026.10.70",
			bootId: ROCK_BOOT,
		});
		const dir = stateDir(fresh);
		// Then the new receipt is never retired by the old judgement.
		expect(retireStagedReceipt(rockReceipt, dir)).toBe(false);
		expect(readFileSync(join(dir, "os-staged.json"), "utf8")).toBe(fresh);
		expect(existsSync(join(dir, CONSUMED_RECEIPT_NAME))).toBe(false);
	});

	test("leaves an unreadable receipt for the strict reader to refuse", () => {
		const dir = stateDir("{");
		expect(retireStagedReceipt(rockReceipt, dir)).toBe(false);
		expect(readFileSync(join(dir, "os-staged.json"), "utf8")).toBe("{");
	});

	test.each([
		["before the rename", true],
		["after the rename", false],
	] as const)(
		"converges from crash residue %s, and repeats as a no-op",
		(_label, liveSurvived) => {
			// Given SIGKILL left either the live receipt or only its tombstone,
			// beside an older tombstone from a previous retirement.
			const dir = stateDir(liveSurvived ? ROCK_RECEIPT_BYTES : undefined);
			writeFileSync(
				join(dir, CONSUMED_RECEIPT_NAME),
				liveSurvived ? "older" : ROCK_RECEIPT_BYTES,
			);
			// When retirement runs again, twice.
			retireStagedReceipt(rockReceipt, dir);
			expect(retireStagedReceipt(rockReceipt, dir)).toBe(false);
			// Then exactly one state remains: no live receipt, the judged tombstone.
			expect(existsSync(join(dir, "os-staged.json"))).toBe(false);
			expect(readFileSync(join(dir, CONSUMED_RECEIPT_NAME), "utf8")).toBe(
				ROCK_RECEIPT_BYTES,
			);
		},
	);
});

describe("retireConsumedStagedReceipt", () => {
	function port(overrides: Partial<ReceiptRetirementPort> = {}) {
		const retired: OsStageReceipt[] = [];
		const value: ReceiptRetirementPort = {
			snapshot: () => ({
				phase: "failed",
				activeAttemptId: null,
				generation: 1,
				producing: false,
			}),
			acquireControl: acquireTestOsStageControl,
			readReceipt: async () => rockReceipt,
			readBootedVersion: async () => "2026.10.64",
			readBootId: async () => ROCK_BOOT,
			readHealthyBootId: async () => ROCK_BOOT,
			readActivationArmed: async () => false,
			inspectOperation: async () => "idle",
			retire: (receipt) => {
				retired.push(receipt);
				return true;
			},
			...overrides,
		};
		return { value, retired };
	}

	test("retires the Rock's consumed receipt under CONTROL", async () => {
		const { value, retired } = port();
		expect(await retireConsumedStagedReceipt(value)).toBe(true);
		expect(retired).toEqual([rockReceipt]);
	});

	test("judges the receipt read under the lease, not the first read", async () => {
		// Given a crash-reboot rebind lands between the unlocked and locked reads.
		let reads = 0;
		const { value, retired } = port({
			readReceipt: async () =>
				reads++ === 0 ? rockReceipt : { ...rockReceipt, bootId: ROCK_BOOT },
		});
		expect(await retireConsumedStagedReceipt(value)).toBe(false);
		expect(retired).toEqual([]);
	});

	test("defers when the orchestrator moved during the evidence reads", async () => {
		let generation = 1;
		const { value, retired } = port({
			snapshot: () => ({
				phase: "failed",
				activeAttemptId: null,
				generation,
				producing: false,
			}),
			inspectOperation: async () => {
				generation++;
				return "idle";
			},
		});
		expect(await retireConsumedStagedReceipt(value)).toBe(false);
		expect(retired).toEqual([]);
	});

	test("never touches a receipt while a producer runs", async () => {
		let reads = 0;
		const { value, retired } = port({
			snapshot: () => ({
				phase: "idle",
				activeAttemptId: null,
				generation: 1,
				producing: true,
			}),
			readReceipt: async () => {
				reads++;
				return rockReceipt;
			},
		});
		expect(await retireConsumedStagedReceipt(value)).toBe(false);
		expect({ reads, retired }).toEqual({ reads: 0, retired: [] });
	});
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
		const dir = stateDir();
		await recoveryHarness({
			readPersistedState: async () => structuredClone(getOrchestratorState()),
			inspectOsOperation: async () => "idle",
			proveOsWriterQuiescent: async () => true,
			readActivationArmed: async () => false,
			readOsReceipt: async () => {
				const file = Bun.file(join(dir, "os-staged.json"));
				return (await file.exists())
					? ((await file.json()) as OsStageReceipt)
					: undefined;
			},
			retireOsReceipt: (receipt) => retireStagedReceipt(receipt, dir),
			readBootId: async () => ROCK_BOOT,
			readBootedVersion: async () => "2026.10.64",
			readHealthyState: async () => ({
				boot_id: ROCK_BOOT,
				slot: "A",
				build_id: "b",
				dpkg_status_sha256: "d".repeat(64),
				recorded_at: "2026-10-09T10:00:00Z",
			}),
			readRootSlots: async () => slots(other),
		});
		writeFileSync(join(dir, "os-staged.json"), ROCK_RECEIPT_BYTES);
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
			ROCK_RECEIPT_BYTES,
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
