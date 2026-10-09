// A staged receipt outlives its purpose once the version it names is the
// healthy running OS. Left in place it reads as "a stage may exist", which
// blocks every OS-failure settlement proof forever. The receipt records no
// target slot, so consumption is judged only from what it does record.
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { logger } from "../../../helpers/logger.ts";
import { syncOrchestratorDirectory } from "./orchestrator-directory-sync.ts";
import type { OsStageReceipt } from "./os-agent.ts";
import { OS_UPDATE_STATE_DIR } from "./os-manifest.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import type { OrchestratorPhase } from "./types.ts";

export const CONSUMED_RECEIPT_NAME = "os-staged.consumed.json";

export type StagedReceiptEvidence = {
	readonly receipt: OsStageReceipt;
	readonly phase: OrchestratorPhase;
	readonly activeAttemptId: string | null;
	readonly bootedVersion: string | undefined;
	readonly bootId: string;
	readonly healthyBootId: string | null;
	readonly activationArmed: boolean;
	readonly raucOperation: "idle" | "running";
};

/** Phases that still own the receipt: staging, staged, armed or verifying. */
export function receiptLifecycleOpen(phase: OrchestratorPhase): boolean {
	switch (phase) {
		case "os-staging":
		case "os-staged":
		case "os-activation-armed":
		case "os-verifying":
			return true;
		case "idle":
		case "checking":
		case "available":
		case "downloading":
		case "awaiting-idle":
		case "committing":
		case "restarting-services":
		case "settled":
		case "os-available":
		case "sync-eligible":
		case "syncing":
		case "synced":
		case "quarantined":
		case "failed":
			return false;
		default: {
			const unreachable: never = phase;
			return unreachable;
		}
	}
}

/**
 * Consumed means: its version is the booted OS, this boot passed its
 * healthcheck, it was written on an earlier boot, and nothing is staging,
 * armed or verifying. A receipt for any other version is never consumed,
 * and a pending activation keeps its receipt rebound to the current boot.
 */
export function stagedReceiptConsumed(
	evidence: StagedReceiptEvidence,
): boolean {
	return (
		!receiptLifecycleOpen(evidence.phase) &&
		evidence.activeAttemptId === null &&
		evidence.bootedVersion !== undefined &&
		evidence.receipt.version === evidence.bootedVersion &&
		evidence.receipt.bootId !== evidence.bootId &&
		evidence.healthyBootId === evidence.bootId &&
		!evidence.activationArmed &&
		evidence.raucOperation === "idle"
	);
}

/**
 * Renames exactly the receipt that was judged, keeping it as evidence. A
 * different, unreadable or already-retired receipt is left alone. The rename
 * is atomic; a crash before the directory sync re-runs to the same result.
 */
export function retireStagedReceipt(
	judged: OsStageReceipt,
	dir = OS_UPDATE_STATE_DIR,
): boolean {
	const live = join(dir, "os-staged.json");
	let current: unknown;
	try {
		current = JSON.parse(readFileSync(live, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) return false;
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
	if (!isDeepStrictEqual(current, judged)) return false;
	renameSync(live, join(dir, CONSUMED_RECEIPT_NAME));
	syncOrchestratorDirectory(live);
	return true;
}

export type ReceiptRetirementPort = {
	readonly snapshot: () => {
		readonly phase: OrchestratorPhase;
		readonly activeAttemptId: string | null;
		readonly generation: number;
		readonly producing: boolean;
	};
	readonly acquireControl: () => Promise<OsStageControlLease>;
	readonly readReceipt: () => Promise<OsStageReceipt | undefined>;
	readonly readBootedVersion: () => Promise<string | undefined>;
	readonly readBootId: () => Promise<string>;
	readonly readHealthyBootId: () => Promise<string | null>;
	readonly readActivationArmed: () => Promise<boolean>;
	readonly inspectOperation: () => Promise<"idle" | "running">;
	readonly retire: (receipt: OsStageReceipt) => boolean;
};

/**
 * Judges under CONTROL, against evidence read after the lease and a state
 * snapshot taken after every read; any movement defers to a later pass.
 */
export async function retireConsumedStagedReceipt(
	port: ReceiptRetirementPort,
): Promise<boolean> {
	const before = port.snapshot();
	if (before.producing || receiptLifecycleOpen(before.phase)) return false;
	if (!(await port.readReceipt())) return false;
	await using lease = await port.acquireControl();
	const [receipt, bootedVersion, bootId, healthyBootId, armed, operation] =
		await Promise.all([
			port.readReceipt(),
			port.readBootedVersion(),
			port.readBootId(),
			port.readHealthyBootId(),
			port.readActivationArmed(),
			port.inspectOperation(),
		]);
	const current = port.snapshot();
	if (
		!receipt ||
		!lease.held() ||
		current.producing ||
		current.generation !== before.generation ||
		!stagedReceiptConsumed({
			receipt,
			phase: current.phase,
			activeAttemptId: current.activeAttemptId,
			bootedVersion,
			bootId,
			healthyBootId,
			activationArmed: armed,
			raucOperation: operation,
		}) ||
		!port.retire(receipt)
	)
		return false;
	logger.info("update-orchestrator: consumed staged receipt retired", {
		version: receipt.version,
		stagedBootId: receipt.bootId,
	});
	return true;
}
