import { OsStageError } from "./os-stage-error.ts";

export type StageDeadline = {
	readonly deadline: number;
	readonly now: () => number;
	readonly invalidate?: () => void;
	readonly assert?: () => void;
};

export function createStageDeadline(
	input: StageDeadline,
): StageDeadline & Required<Pick<StageDeadline, "assert" | "invalidate">> {
	let active = true;
	return {
		...input,
		invalidate: () => {
			active = false;
			input.invalidate?.();
		},
		assert: () => {
			if (!active) throw new OsStageError("rauc_recovery_unproven");
			input.assert?.();
		},
	};
}

export function assertStageDeadline(budget: StageDeadline): void {
	budget.assert?.();
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
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = () => {
		budget.invalidate?.();
		return new OsStageError("rauc_recovery_unproven", {
			diagnostics: { refusal: "deadline-expired" },
		});
	};
	try {
		assertStageDeadline(budget);
		const value = await Promise.race([
			work(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(expired()),
					Math.max(0, budget.deadline - budget.now()),
				);
			}),
		]);
		assertStageDeadline(budget);
		return value;
	} finally {
		clearTimeout(timer);
	}
}
