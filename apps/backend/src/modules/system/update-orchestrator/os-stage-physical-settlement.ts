import { OsStageError } from "./os-stage-error.ts";

export async function withOsPhysicalSettlement<T>(
	work: () => Promise<T>,
): Promise<T> {
	try {
		return await work();
	} catch (cause) {
		if (
			cause instanceof OsStageError &&
			cause.reason === "rauc_recovery_unproven"
		)
			throw cause;
		const error = new OsStageError("rauc_recovery_unproven", { cause });
		if (cause instanceof Error) error.message += `: ${cause.message}`;
		throw error;
	}
}
