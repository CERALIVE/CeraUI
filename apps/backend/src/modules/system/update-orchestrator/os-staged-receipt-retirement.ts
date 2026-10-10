// Legacy version-only receipts cannot prove consumption. Destructive cleanup
// requires independent installed-image identity and persisted CONTROL authority.
import { isDeepStrictEqual } from "node:util";
import { logger } from "../../../helpers/logger.ts";
import type { JudgedOsReceipt, OsStageReceipt } from "./os-agent.ts";
import type { InstalledImageIdentity } from "./os-installed-image.ts";
import { sameOsRecoveryIdentity } from "./os-recovery-identity.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import type { loadOrchestratorState } from "./persistence.ts";
import type { OrchestratorPhase, OrchestratorState } from "./types.ts";

export {
	CONSUMED_RECEIPT_NAME,
	retireStagedReceipt,
} from "./os-receipt-retirement-store.ts";

export type StagedReceiptEvidence = {
	readonly receipt: OsStageReceipt;
	readonly phase: OrchestratorPhase;
	readonly activeAttemptId: string | null;
	readonly bootedVersion: string | undefined;
	readonly bootId: string;
	readonly healthyBootId: string | null;
	readonly activationArmed: boolean;
	readonly raucOperation: "idle" | "running";
	readonly bootedImage?: InstalledImageIdentity | null;
};

/** Open OS lifecycles and package commit withhold receipt cleanup. */
export function receiptLifecycleOpen(phase: OrchestratorPhase): boolean {
	switch (phase) {
		case "os-staging":
		case "os-staged":
		case "os-activation-armed":
		case "os-verifying":
		case "committing":
			return true;
		case "idle":
		case "checking":
		case "available":
		case "downloading":
		case "awaiting-idle":
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

/** Stamp equality never substitutes for the receipt's installed-image binding. */
export function stagedReceiptConsumed(
	evidence: StagedReceiptEvidence,
): boolean {
	return (
		!receiptLifecycleOpen(evidence.phase) &&
		evidence.receipt.installedImage !== undefined &&
		evidence.bootedImage !== undefined &&
		evidence.bootedImage !== null &&
		isDeepStrictEqual(evidence.receipt.installedImage, evidence.bootedImage) &&
		evidence.activeAttemptId === null &&
		evidence.bootedVersion !== undefined &&
		evidence.receipt.version === evidence.bootedVersion &&
		evidence.receipt.bootId !== evidence.bootId &&
		evidence.healthyBootId === evidence.bootId &&
		!evidence.activationArmed &&
		evidence.raucOperation === "idle"
	);
}

export type ReceiptRetirementPort = {
	readonly snapshot: () => {
		readonly state: OrchestratorState;
		readonly phase: OrchestratorPhase;
		readonly activeAttemptId: string | null;
		readonly generation: number;
		readonly producing: boolean;
	};
	readonly acquireControl: () => Promise<OsStageControlLease>;
	readonly readPersisted: typeof loadOrchestratorState;
	readonly readReceipt: () => Promise<JudgedOsReceipt | undefined>;
	readonly readBootedVersion: () => Promise<string | undefined>;
	readonly readBootId: () => Promise<string>;
	readonly readHealthyBootId: () => Promise<string | null>;
	readonly readBootedImage: () => Promise<InstalledImageIdentity | null>;
	readonly readActivationArmed: () => Promise<boolean>;
	readonly inspectOperation: () => Promise<"idle" | "running">;
	readonly retire: (receipt: JudgedOsReceipt) => boolean;
	readonly acknowledge?: () => void;
	readonly acknowledgementPending?: () => boolean;
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
	const prior = await port.readReceipt();
	if (!prior && !port.acknowledgementPending?.()) return false;
	await using lease = await port.acquireControl();
	if (!lease.held()) return false;
	const authority = await port.readPersisted();
	if (
		!sameOsRecoveryIdentity(before.state, authority) ||
		!authority ||
		receiptLifecycleOpen(authority.phase) ||
		authority.osStageRecovery?.activeAttemptId
	)
		return false;
	port.acknowledge?.();
	if (!prior) return false;
	const [
		receipt,
		bootedVersion,
		bootId,
		healthyBootId,
		armed,
		operation,
		bootedImage,
	] = await Promise.all([
		port.readReceipt(),
		port.readBootedVersion(),
		port.readBootId(),
		port.readHealthyBootId(),
		port.readActivationArmed(),
		port.inspectOperation(),
		port.readBootedImage(),
	]);
	const persisted = await port.readPersisted();
	const finalArmed = await port.readActivationArmed();
	const current = port.snapshot();
	if (
		!receipt ||
		!lease.held() ||
		current.producing ||
		current.generation !== before.generation ||
		!sameOsRecoveryIdentity(current.state, persisted) ||
		!stagedReceiptConsumed({
			receipt: receipt.receipt,
			phase: current.phase,
			activeAttemptId: current.activeAttemptId,
			bootedVersion,
			bootId,
			healthyBootId,
			activationArmed: armed || finalArmed,
			raucOperation: operation,
			bootedImage,
		}) ||
		!port.retire(receipt)
	)
		return false;
	logger.info("update-orchestrator: consumed staged receipt retired", {
		version: receipt.receipt.version,
		stagedBootId: receipt.receipt.bootId,
	});
	return true;
}
