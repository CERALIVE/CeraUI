import {
	assertStageDeadline,
	type StageDeadline,
	withinStageDeadline,
} from "./os-stage-deadline.ts";
import { OsStageError } from "./os-stage-error.ts";
import {
	type RaucAttemptOwnership,
	type RaucStageSnapshot,
	raucQuiescenceRefusal,
} from "./os-stage-recovery.ts";

type RetainedPin = {
	readonly ownership: RaucAttemptOwnership;
	readonly observe: () => Promise<RaucStageSnapshot | null>;
	readonly lockHeld: () => Promise<boolean>;
	readonly cliSettled: () => boolean;
	readonly requireNewInstance: boolean;
	readonly drain: () => Promise<unknown>;
	readonly prepareCleanup?: (budget: StageDeadline) => void;
	readonly release: () => void;
};
const retained = new Map<string, RetainedPin>();

export async function retainUnsafeOsStagePin(
	input: Omit<RetainedPin, "release"> & {
		readonly attemptId: string;
		readonly error: OsStageError;
		readonly notify: (error: OsStageError) => void;
	},
): Promise<never> {
	const gate = Promise.withResolvers<void>();
	retained.set(input.attemptId, { ...input, release: () => gate.resolve() });
	input.notify(input.error);
	// Keep runPinnedStep's unchanged finally parked while the old writer is unproven.
	await gate.promise;
	throw input.error;
}

export async function drainRetainedOsStagePin(
	attemptId: string,
	budget: StageDeadline,
): Promise<void> {
	const pin = retained.get(attemptId);
	if (!pin) return;
	const lockHeld = await withinStageDeadline(budget, pin.lockHeld);
	const current = await withinStageDeadline(budget, pin.observe);
	assertStageDeadline(budget);
	const refusal = raucQuiescenceRefusal({
		ownership: pin.ownership,
		current,
		lockHeld,
		cliSettled: pin.cliSettled(),
		requireNewInstance: pin.requireNewInstance,
	});
	if (refusal)
		throw new OsStageError("rauc_recovery_unproven", {
			diagnostics: { refusal },
		});
	pin.prepareCleanup?.(budget);
	pin.release();
	await withinStageDeadline(budget, pin.drain);
	retained.delete(attemptId);
}
