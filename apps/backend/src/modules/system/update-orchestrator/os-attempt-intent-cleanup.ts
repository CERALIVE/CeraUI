import { isDeepStrictEqual } from "node:util";
import { logger } from "../../../helpers/logger.ts";
import type { OsAttemptIntent } from "./os-attempt-intent.ts";
import {
	type OsAttemptIntentRecoveryPort,
	recoverOsAttemptIntent,
	retireSettledOsAttemptIntent,
} from "./os-attempt-intent-recovery.ts";
import {
	type OsAttemptIntentStore,
	osAttemptIntentStore,
} from "./os-attempt-intent-store.ts";
import type { OsRecoverySettlementPort } from "./os-authoritative-settlement.ts";
import type { OsSettlementPersistence } from "./os-settlement-persistence.ts";
import {
	borrowOsStageControlLease,
	type OsStageControlLease,
} from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import { toPersisted } from "./persistence.ts";

export class OsAttemptIntentCleanup {
	#pending = false;
	#failure: OsStageError | undefined;
	#flight: Promise<boolean> | undefined;
	#revision = 0;

	get pending(): boolean {
		return this.#pending;
	}

	assertAcknowledged(): void {
		if (this.#pending)
			throw this.#failure ?? new OsStageError("rauc_recovery_unproven");
	}

	retire(store: OsAttemptIntentStore, intent: OsAttemptIntent): void {
		this.#pending = true;
		store.retire(intent);
		this.#pending = false;
		this.#failure = undefined;
	}

	run(operation: () => Promise<boolean>, attemptId?: string): Promise<boolean> {
		if (this.#flight) return this.#flight;
		const revision = this.#revision;
		this.#pending = true;
		const flight = (async () => {
			try {
				const result = await operation();
				if (this.#revision === revision) {
					this.#pending = false;
					this.#failure = undefined;
				}
				return result;
			} catch (cause) {
				if (this.#revision === revision) this.#pending = true;
				const error =
					cause instanceof OsStageError
						? cause
						: new OsStageError("rauc_recovery_unproven", { cause });
				if (this.#revision === revision) this.#failure = error;
				logger.warn(
					"update-orchestrator: intent retirement pending; admission remains closed",
					{
						event: "intent-retirement-pending",
						attemptId,
						error,
					},
				);
				return false;
			}
		})().finally(() => {
			if (this.#flight === flight) this.#flight = undefined;
		});
		this.#flight = flight;
		return flight;
	}

	resetForTest(): void {
		this.#revision++;
		this.#pending = false;
		this.#failure = undefined;
		this.#flight = undefined;
	}
}

export async function finishOsAttemptIntent(
	port: OsRecoverySettlementPort & {
		readonly lease: OsStageControlLease;
		readonly attemptId: string;
	},
	durability: OsSettlementPersistence,
	store?: OsAttemptIntentStore,
): Promise<void> {
	await durability.intentCleanup.run(async () => {
		const completed = await retireSettledOsAttemptIntent(
			{ ...port, pending: () => durability.snapshotPending },
			store,
			durability.intentCleanup,
		);
		if (!completed) throw new OsStageError("rauc_recovery_unproven");
		return false;
	}, port.attemptId);
}

export async function recoverOsAttemptLifecycle(
	port: OsAttemptIntentRecoveryPort,
	durability: OsSettlementPersistence,
): Promise<boolean> {
	return durability.intentRecovery.run(async () => {
		const recovery = {
			...port,
			pending: () => durability.snapshotPending,
			retire: (store: OsAttemptIntentStore, intent: OsAttemptIntent) =>
				durability.intentCleanup.retire(store, intent),
		};
		if (!durability.intentCleanup.pending)
			return recoverOsAttemptIntent(recovery);
		return durability.intentCleanup.run(async () => {
			await using lease = await port.acquireControl();
			await recoverOsAttemptIntent({
				...recovery,
				acquireControl: async () => borrowOsStageControlLease(lease),
			});
			const current = port.snapshot();
			const persisted = await port.readPersisted();
			if (
				!lease.held() ||
				durability.snapshotPending ||
				port.snapshot() !== current ||
				!persisted ||
				!isDeepStrictEqual(toPersisted(current), toPersisted(persisted))
			)
				throw new OsStageError("rauc_recovery_unproven");
			const store = port.store ?? osAttemptIntentStore();
			if (store.read()) throw new OsStageError("rauc_recovery_unproven");
			store.synchronize();
			return true;
		});
	});
}
