import { isDeepStrictEqual } from "node:util";
import { logger } from "../../../helpers/logger.ts";
import type { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import type { OsAttemptIntent } from "./os-attempt-intent.ts";
import type { OsAttemptIntentCleanup } from "./os-attempt-intent-cleanup.ts";
import { assertIntentProducerAbsent } from "./os-attempt-intent-ownership.ts";
import {
	type OsAttemptIntentStore,
	osAttemptIntentStore,
} from "./os-attempt-intent-store.ts";
import type { OsRecoverySettlementPort } from "./os-authoritative-settlement.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { readOsStageJob } from "./os-stage-job-files.ts";
import type { OsStageSettlementEvidence } from "./os-stage-retry.ts";
import type { readOsUnlaunchedWitness } from "./os-stage-unlaunched-witness.ts";
import { fromPersisted, toPersisted } from "./persistence.ts";
import type { OrchestratorState } from "./types.ts";

export type OsAttemptIntentRecoveryPort = OsRecoverySettlementPort & {
	readonly store?: OsAttemptIntentStore;
	readonly readJob: typeof readOsStageJob;
	readonly readWitness: typeof readOsUnlaunchedWitness;
	readonly run?: typeof spawnWithTimeout;
	readonly readEvidence: (
		lease: OsStageControlLease,
	) => Promise<OsStageSettlementEvidence | undefined>;
	readonly adopt: (state: OrchestratorState) => void;
};

export async function recoverOsAttemptIntent(
	port: OsAttemptIntentRecoveryPort & {
		readonly retire: (
			store: OsAttemptIntentStore,
			intent: OsAttemptIntent,
		) => void;
	},
): Promise<boolean> {
	const store = port.store ?? osAttemptIntentStore();
	if (!store.read()) return false;
	await using lease = await port.acquireControl();
	const intent = store.read();
	const before = port.snapshot();
	const persisted = await port.readPersisted();
	if (
		!intent ||
		!lease.held() ||
		port.pending() ||
		!isDeepStrictEqual(toPersisted(port.snapshot()), toPersisted(before)) ||
		!persisted ||
		!isDeepStrictEqual(toPersisted(before), toPersisted(persisted))
	)
		throw new OsStageError("rauc_recovery_unproven");
	const disk = toPersisted(persisted);
	switch (intent.phase) {
		case "launching": {
			if (isDeepStrictEqual(disk, intent.before)) break;
			const record = persisted.osStageRecovery;
			if (record?.attemptId !== intent.attemptId) {
				await assertIntentProducerAbsent(port, intent.attemptId);
				const fresh = await port.readPersisted();
				if (
					!lease.held() ||
					port.pending() ||
					!isDeepStrictEqual(toPersisted(port.snapshot()), disk) ||
					!fresh ||
					!isDeepStrictEqual(toPersisted(fresh), disk) ||
					!isDeepStrictEqual(store.read(), intent)
				)
					throw new OsStageError("rauc_recovery_unproven");
				port.retire(store, intent);
				logger.warn("update-orchestrator: stale launched intent retired", {
					event: "stale-launching-intent-retired",
					attemptId: intent.attemptId,
					currentAttemptId: record?.attemptId ?? null,
				});
				return false;
			}
			if (record.candidateKey !== intent.staged.osStageRecovery?.candidateKey)
				throw new OsStageError("rauc_recovery_unproven");
			if (record.activeAttemptId === null) port.retire(store, intent);
			return false;
		}
		case "publishing": {
			if (
				!isDeepStrictEqual(disk, intent.before) &&
				!isDeepStrictEqual(disk, intent.staged)
			)
				throw new OsStageError("rauc_recovery_unproven");
			break;
		}
		default: {
			const unreachable: never = intent.phase;
			return unreachable;
		}
	}
	// An intent is additional authority, never a replacement for ownership proof.
	await assertIntentProducerAbsent(port, intent.attemptId);
	const evidence = await port.readEvidence(lease);
	const fresh = await port.readPersisted();
	if (
		!lease.held() ||
		!isDeepStrictEqual(toPersisted(port.snapshot()), disk) ||
		!fresh ||
		!isDeepStrictEqual(toPersisted(fresh), disk) ||
		!isDeepStrictEqual(store.read(), intent) ||
		!evidence?.writerQuiescent ||
		evidence.raucOperation !== "idle" ||
		evidence.stagedReceiptPresent ||
		evidence.activationArmed ||
		evidence.bootId !== evidence.healthyBootId ||
		evidence.rootSlots.length !== 2 ||
		evidence.rootSlots.filter(
			(slot) => slot.state === "booted" && slot.bootStatus === "good",
		).length !== 1 ||
		evidence.rootSlots.filter((slot) => slot.state === "inactive").length !== 1
	)
		throw new OsStageError("rauc_recovery_unproven");
	const restored = fromPersisted(intent.before);
	port.adopt(restored);
	if (port.persistSnapshot) port.persistSnapshot(persisted, restored);
	else port.persist(restored);
	port.retire(store, intent);
	return true;
}

export async function retireSettledOsAttemptIntent(
	port: OsRecoverySettlementPort & {
		readonly lease: OsStageControlLease;
		readonly attemptId: string;
	},
	store = osAttemptIntentStore(),
	cleanup: OsAttemptIntentCleanup,
): Promise<boolean> {
	const intent = store.read();
	if (!intent) return true;
	if (intent.attemptId !== port.attemptId)
		throw new OsStageError("rauc_recovery_unproven");
	const before = port.snapshot();
	const persisted = await port.readPersisted();
	if (
		intent.phase !== "launching" ||
		before.osStageRecovery?.activeAttemptId ||
		port.pending()
	)
		return false;
	if (
		!port.lease.held() ||
		port.snapshot() !== before ||
		!persisted ||
		!isDeepStrictEqual(toPersisted(before), toPersisted(persisted))
	)
		throw new OsStageError("rauc_recovery_unproven");
	cleanup.retire(store, intent);
	return true;
}
