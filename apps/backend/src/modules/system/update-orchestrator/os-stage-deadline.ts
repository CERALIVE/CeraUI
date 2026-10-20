import { OsStageError } from "./os-stage-error.ts";

export type StageDeadline = {
	readonly deadline: number;
	readonly now: () => number;
	readonly invalidate?: () => void;
	readonly fence?: () => void;
};

export function createStageDeadline(
	input: StageDeadline,
): StageDeadline & Required<Pick<StageDeadline, "fence" | "invalidate">> {
	let active = true;
	return {
		...input,
		invalidate: () => {
			active = false;
			input.invalidate?.();
		},
		fence: () => {
			if (!active) throw new OsStageError("rauc_recovery_unproven");
			input.fence?.();
		},
	};
}

export function assertStageDeadline(budget: StageDeadline): void {
	budget.fence?.();
	if (budget.now() >= budget.deadline) {
		budget.invalidate?.();
		throw new OsStageError("rauc_recovery_unproven", {
			diagnostics: { refusal: "deadline-expired" },
		});
	}
}

export async function withinStageDeadline<T>(
	budget: StageDeadline,
	work: () => Promise<T>,
): Promise<T> {
	assertStageDeadline(budget);
	const value = await raceStageDeadline(budget, work);
	assertStageDeadline(budget);
	return value;
}

/**
 * Races work against the deadline without the start/finish clock checks, for
 * diagnostic reads whose caller re-checks the clock before any authorization.
 */
export async function raceStageDeadline<T>(
	budget: StageDeadline,
	work: () => Promise<T>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = () => {
		budget.invalidate?.();
		return new OsStageError("rauc_recovery_unproven", {
			diagnostics: { refusal: "deadline-expired" },
		});
	};
	try {
		return await Promise.race([
			work(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(expired()),
					Math.max(0, budget.deadline - budget.now()),
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
