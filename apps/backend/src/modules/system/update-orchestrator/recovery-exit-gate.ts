import { isDeepStrictEqual } from "node:util";
import type { OsRecoverySettlementPort } from "./os-authoritative-settlement.ts";
import { OsStageError } from "./os-stage-error.ts";
import { pendingPackageSuccess } from "./pending-success-fence.ts";
import { toPersisted } from "./persistence.ts";
import { reduceOrchestrator } from "./reducer.ts";
import type { OrchestratorState } from "./types.ts";

let recoveredExitHook: (() => Promise<boolean>) | undefined;
let exitController = new AbortController();

export function reserveRecoveredUpdateExit(
	hook: (signal: AbortSignal) => Promise<boolean>,
): void {
	// A retried startup joins the original recovery owner, never replaces its hook.
	const signal = exitController.signal;
	recoveredExitHook ??= async () => {
		if (signal.aborted) return false;
		const cancelled = Promise.withResolvers<boolean>();
		const abort = () => cancelled.resolve(false);
		signal.addEventListener("abort", abort, { once: true });
		try {
			return await Promise.race([hook(signal), cancelled.promise]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
}

export function getRecoveredUpdateExitHook():
	| (() => Promise<boolean>)
	| undefined {
	return recoveredExitHook;
}

export function resetRecoveredUpdateExitForTest(): void {
	exitController.abort();
	exitController = new AbortController();
	recoveredExitHook = undefined;
}

export async function persistRecoveredCommitSuccess(
	port: OsRecoverySettlementPort & { readonly signal?: AbortSignal },
	accept: (state: OrchestratorState) => void,
	now: number,
): Promise<boolean> {
	await using lease = await port.acquireControl();
	if (port.signal?.aborted) return false;
	const before = port.snapshot();
	const persisted = await port.readPersisted();
	if (port.signal?.aborted) return false;
	if (
		!lease.held() ||
		port.pending() ||
		port.snapshot() !== before ||
		!persisted ||
		!isDeepStrictEqual(toPersisted(before), toPersisted(persisted))
	)
		throw new OsStageError("rauc_recovery_unproven");
	if (before.phase === "restarting-services" || before.phase === "settled") {
		if (pendingPackageSuccess.pending) {
			pendingPackageSuccess.retain(before, before);
			port.persist(before);
		}
		pendingPackageSuccess.acknowledge(before);
		return true;
	}
	if (before.phase !== "committing" && before.phase !== "downloading")
		return false;
	const committing = reduceOrchestrator(before, {
		type: "COMMIT_PHASE_ENTERED",
		now,
	});
	const success = reduceOrchestrator(committing, {
		type: "COMMIT_SUCCEEDED",
		now,
	});
	pendingPackageSuccess.retain(before, success);
	port.persist(success);
	accept(success);
	pendingPackageSuccess.acknowledge(success);
	return true;
}
