import { logger } from "../../../helpers/logger.ts";
import { OsStageError } from "./os-stage-error.ts";
import { OrchestratorRecoveryLoadError } from "./persistence.ts";

export const UPDATE_STARTUP_RETRY_DELAYS_MS = [
	250, 500, 1_000, 2_000, 4_000,
] as const;

export type StartupRetryClock = {
	readonly wait: (milliseconds: number) => Promise<void>;
	/** Injected burst-only clocks leave later retries inert unless explicitly supplied. */
	readonly scheduleBackground?: (
		work: () => Promise<void>,
		milliseconds: number,
	) => { readonly unref: () => void; readonly cancel: () => void };
};

export const defaultStartupRetryClock: StartupRetryClock = {
	wait: (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
	scheduleBackground: (work, milliseconds) => {
		const timer = setTimeout(() => void work(), milliseconds);
		return { unref: () => timer.unref(), cancel: () => clearTimeout(timer) };
	},
};

export function isTransientUpdateStartupFailure(
	error: unknown,
): error is Error {
	return (
		error instanceof Error &&
		!(error instanceof OrchestratorRecoveryLoadError) &&
		!(
			error instanceof OsStageError &&
			error.reason !== "os_update_lock_held" &&
			error.cause === undefined
		)
	);
}

/** One startup flight owns this finite retry budget; operator calls never rearm it. */
export async function retryUpdateStartup(
	work: () => Promise<void>,
	retryClock: StartupRetryClock = defaultStartupRetryClock,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await work();
			return;
		} catch (error) {
			if (!isTransientUpdateStartupFailure(error)) throw error;
			const delayMs = UPDATE_STARTUP_RETRY_DELAYS_MS[attempt];
			if (delayMs === undefined) throw error;
			logger.warn("update-orchestrator: startup deferred; retry scheduled", {
				attempt: attempt + 1,
				delayMs,
				error,
			});
			await retryClock.wait(delayMs);
		}
	}
}
