import { OsStageError } from "./os-stage-error.ts";

export type StageDeadline = {
	readonly deadline: number;
	readonly now: () => number;
	readonly invalidate?: () => void;
};

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
		const value = await Promise.race([
			work(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(expired()),
					Math.max(0, budget.deadline - budget.now()),
				);
			}),
		]);
		return value;
	} finally {
		clearTimeout(timer);
	}
}
