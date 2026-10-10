import type { OsChannelManifest } from "./os-manifest.ts";
import {
	type ReceiptFileIdentity,
	readReceiptFile,
	sameReceiptFile,
} from "./os-receipt-file-identity.ts";
import { sameOsRecoveryIdentity } from "./os-recovery-identity.ts";
import {
	acquireOsStageControlLease,
	type OsStageControlLease,
} from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { OsStageSettlementEvidence } from "./os-stage-retry.ts";
import type { readOsUnlaunchedWitness } from "./os-stage-unlaunched-witness.ts";
import {
	type OsUnlaunchedStageSettlement,
	reduceOsUnlaunchedSettlement,
} from "./os-unlaunched-state.ts";
import { loadOrchestratorState } from "./persistence.ts";
import type { OrchestratorState } from "./types.ts";

export type OsUnlaunchedSnapshot = {
	readonly state: OrchestratorState;
	readonly generation: number;
	readonly candidate: OsChannelManifest | undefined;
	readonly producer: object | undefined;
};

export type OsUnlaunchedSettlementPort = {
	readonly snapshot: () => OsUnlaunchedSnapshot;
	readonly readWitness: typeof readOsUnlaunchedWitness;
	readonly readEvidence: (
		lease?: OsStageControlLease,
	) => Promise<OsStageSettlementEvidence | undefined>;
	readonly dispatch: (event: OsUnlaunchedStageSettlement) => OrchestratorState;
	readonly persist: (state: OrchestratorState) => void;
	readonly consume: (attemptId: string) => void;
	readonly now: () => number;
	readonly acquireControl?: typeof acquireOsStageControlLease;
	readonly readPersisted?: typeof loadOrchestratorState;
	readonly persistSettlement?: (write: () => void) => void;
	readonly readReceiptIdentity?: () => ReceiptFileIdentity | null;
};

export async function settleOsUnlaunchedWitness(
	port: OsUnlaunchedSettlementPort,
): Promise<boolean> {
	const before = port.snapshot();
	const record = before.state.osStageRecovery;
	if (before.producer || !record?.attemptId) return false;
	await using lease = await (
		port.acquireControl ?? acquireOsStageControlLease
	)();
	if (!lease.held()) return false;
	let witness: ReturnType<typeof readOsUnlaunchedWitness>;
	try {
		witness = port.readWitness();
	} catch (error) {
		if (error instanceof OsStageError) return false;
		throw error;
	}
	if (
		!witness ||
		witness.attemptId !== record.attemptId ||
		witness.candidateKey !== record.candidateKey
	)
		return false;
	const evidence = await port.readEvidence(lease);
	const persisted = await (port.readPersisted ?? loadOrchestratorState)();
	const currentReceipt =
		witness.receiptBaseline === undefined
			? undefined
			: (
					port.readReceiptIdentity ??
					(() => readReceiptFile()?.identity ?? null)
				)();
	const receiptOutcomeAbsent =
		witness.receiptBaseline === undefined
			? evidence?.stagedReceiptPresent === false
			: evidence?.stagedReceiptPresent === (currentReceipt !== null) &&
				sameReceiptFile(witness.receiptBaseline, currentReceipt);
	const current = port.snapshot();
	if (
		current.generation !== before.generation ||
		current.state.phase !== before.state.phase ||
		current.candidate !== before.candidate ||
		current.state.osStageRecovery !== record ||
		current.state.osStageRecovery?.activeAttemptId !== record.activeAttemptId ||
		current.producer !== before.producer ||
		!lease.held() ||
		!evidence ||
		evidence.bootId !== witness.bootId ||
		evidence.healthyBootId !== evidence.bootId ||
		evidence.raucOperation !== "idle" ||
		!evidence.writerQuiescent ||
		!receiptOutcomeAbsent ||
		evidence.activationArmed
	)
		return false;
	const booted = evidence.rootSlots.filter((slot) => slot.state === "booted");
	const target = evidence.rootSlots.filter((slot) => slot.state === "inactive");
	if (
		evidence.rootSlots.length !== 2 ||
		booted.length !== 1 ||
		booted[0]?.bootStatus !== "good" ||
		target.length !== 1
	)
		return false;
	const event: OsUnlaunchedStageSettlement = {
		type: "OS_UNLAUNCHED_STAGE_SETTLED",
		now: port.now(),
		bootId: evidence.bootId,
		witness,
	};
	const expected = reduceOsUnlaunchedSettlement(before.state, event);
	if (
		!sameOsRecoveryIdentity(before.state, persisted) &&
		!(
			expected === before.state &&
			persisted &&
			sameOsRecoveryIdentity(
				before.state,
				reduceOsUnlaunchedSettlement(persisted, event),
			)
		)
	)
		throw new OsStageError("rauc_recovery_unproven");
	if (expected === before.state) {
		if (
			before.state.phase !== "os-available" ||
			record.activeAttemptId !== null ||
			record.mode !== "operator" ||
			record.reason !== "rauc_install_failed" ||
			before.state.failureReason !== record.reason ||
			record.failedRounds < 1
		)
			return false;
		// A crash after persistence but before unlink replays cleanup, not a round.
		// Re-persist also repairs dispatch's in-memory adoption if its write threw.
		(port.persistSettlement ?? ((write) => write()))(() =>
			port.persist(before.state),
		);
	} else {
		(port.persistSettlement ?? ((write) => write()))(() => {
			port.dispatch(event);
		});
	}
	port.consume(witness.attemptId);
	return true;
}
