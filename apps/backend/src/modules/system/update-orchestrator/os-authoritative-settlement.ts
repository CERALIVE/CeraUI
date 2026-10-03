import { isDeepStrictEqual } from "node:util";
import { sameOsRecoveryIdentity } from "./os-recovery-identity.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import { type loadOrchestratorState, toPersisted } from "./persistence.ts";
import type { OrchestratorState } from "./types.ts";

export type OsRecoverySettlementPort = {
	readonly snapshot: () => OrchestratorState;
	readonly pending: () => boolean;
	readonly acquireControl: () => Promise<OsStageControlLease>;
	readonly readPersisted: typeof loadOrchestratorState;
	readonly persist: (state: OrchestratorState) => void;
	readonly persistSnapshot?: (
		baseline: OrchestratorState | null,
		settled: OrchestratorState,
	) => void;
};

export type OsRecoverySettlement = AsyncDisposable & {
	readonly lease: OsStageControlLease;
	matches(): Promise<boolean>;
};

export async function beginOsRecoverySettlement(
	port: OsRecoverySettlementPort,
): Promise<OsRecoverySettlement> {
	const before = port.snapshot();
	const lease = await port.acquireControl();
	return {
		lease,
		async matches(): Promise<boolean> {
			const persisted = await port.readPersisted();
			if (!lease.held() || port.pending() || port.snapshot() !== before)
				return false;
			if (!sameOsRecoveryIdentity(before, persisted))
				throw new OsStageError("rauc_recovery_unproven");
			return true;
		},
		async [Symbol.asyncDispose]() {
			await lease[Symbol.asyncDispose]();
		},
	};
}

/** A baseline load is not ownership: re-read under CONTROL before the tail save. */
export async function saveAuthoritativeStartupState(
	port: OsRecoverySettlementPort,
	baseline: OrchestratorState | null,
): Promise<void> {
	await using lease = await port.acquireControl();
	const current = port.snapshot();
	const persisted = await port.readPersisted();
	if (!lease.held() || port.pending() || port.snapshot() !== current)
		throw new OsStageError("rauc_recovery_unproven");
	// Accepted settlement/resume dispatch already committed. Do not write twice.
	if (
		persisted &&
		isDeepStrictEqual(toPersisted(current), toPersisted(persisted))
	)
		return;
	if (sameOsRecoveryIdentity(current, persisted)) {
		if (port.persistSnapshot) port.persistSnapshot(persisted, current);
		else port.persist(current);
		return;
	}
	if (
		!(baseline === null && persisted === null) &&
		!(baseline && sameOsRecoveryIdentity(baseline, persisted))
	)
		throw new OsStageError("rauc_recovery_unproven");
	if (port.persistSnapshot) port.persistSnapshot(persisted, current);
	else port.persist(current);
}
