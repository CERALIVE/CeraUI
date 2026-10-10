import {
	type StageProofWait,
	waitForStageProof,
} from "./os-stage-proof-wait.ts";
import {
	type RaucAttemptOwnership,
	type RaucStageSnapshot,
	raucQuiescenceRefusal,
} from "./os-stage-recovery.ts";

export function observeQuiescence(input: {
	readonly ownership: RaucAttemptOwnership;
	readonly observe: () => Promise<RaucStageSnapshot | null>;
	readonly cliSettled: () => Promise<boolean>;
	readonly lockHeld: () => Promise<boolean>;
	readonly requireNewInstance: boolean;
	readonly wait: StageProofWait;
}): Promise<RaucStageSnapshot> {
	return waitForStageProof({
		wait: input.wait,
		observe: input.observe,
		refusal: async (current) => {
			const state = {
				ownership: input.ownership,
				current,
				cliSettled: await input.cliSettled(),
				lockHeld: await input.lockHeld(),
				requireNewInstance: input.requireNewInstance,
			};
			if (current) {
				const structural = raucQuiescenceRefusal({
					...state,
					current: { ...current, processes: [current.instance] },
				});
				if (structural) return structural;
			}
			return raucQuiescenceRefusal(state);
		},
		retryable: (reason) =>
			["old-installer-survives", "installer-ownership-unproven"].includes(
				reason,
			),
	});
}
