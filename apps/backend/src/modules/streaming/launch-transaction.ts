import { CerastreamTimeoutError } from "@ceralive/cerastream";
import {
	classifyStartFailure,
	StreamStartFailure,
} from "./start-failure-taxonomy.ts";
import {
	START_PHASE_DEADLINES_MS,
	type StartDeadlinePhase,
} from "./start-lifecycle-timing.ts";

type LaunchTimer = ReturnType<typeof globalThis.setTimeout> | number;

export type LaunchDeadlineTimers = {
	readonly schedule: (callback: () => void, delayMs: number) => LaunchTimer;
	readonly cancel: (timer: LaunchTimer) => void;
};

export type LaunchTransaction = {
	readonly register: (cleanup: () => void | Promise<void>) => void;
	readonly runPhase: <Result>(
		phase: StartDeadlinePhase,
		operation: () => Promise<Result>,
		errorPhase?: (error: unknown) => StartDeadlinePhase,
	) => Promise<Result>;
	readonly rollback: () => Promise<void>;
};

const realTimers: LaunchDeadlineTimers = {
	schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	cancel: (timer) => globalThis.clearTimeout(timer),
};

export function createLaunchTransaction(
	attemptId: string,
	options: {
		readonly timers?: LaunchDeadlineTimers;
		readonly warn?: (message: string, meta?: Record<string, unknown>) => void;
	} = {},
): LaunchTransaction {
	const timers = options.timers ?? realTimers;
	const cleanups: Array<() => void | Promise<void>> = [];
	let rolledBack = false;
	let rollbackPromise: Promise<void> | undefined;
	const warn = options.warn ?? (() => undefined);

	const runCleanup = async (
		cleanup: () => void | Promise<void>,
	): Promise<void> => {
		try {
			await cleanup();
		} catch (error) {
			warn("stream launch cleanup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	return {
		register: (cleanup) => {
			if (rolledBack) {
				void runCleanup(cleanup);
				return;
			}
			cleanups.push(cleanup);
		},
		runPhase: async <Result>(
			phase: StartDeadlinePhase,
			operation: () => Promise<Result>,
			errorPhase: (error: unknown) => StartDeadlinePhase = () => phase,
		): Promise<Result> => {
			let timer: LaunchTimer | undefined;
			let deadlineExpired = false;
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = timers.schedule(() => {
					deadlineExpired = true;
					reject(
						new CerastreamTimeoutError(phase, START_PHASE_DEADLINES_MS[phase]),
					);
				}, START_PHASE_DEADLINES_MS[phase]);
			});
			try {
				return await Promise.race([operation(), timeout]);
			} catch (error) {
				throw new StreamStartFailure(
					classifyStartFailure(
						deadlineExpired ? phase : errorPhase(error),
						error,
						attemptId,
						{ warn },
					),
				);
			} finally {
				if (timer !== undefined) timers.cancel(timer);
			}
		},
		rollback: () => {
			if (rollbackPromise !== undefined) return rollbackPromise;
			rolledBack = true;
			rollbackPromise = (async () => {
				for (const cleanup of cleanups.reverse()) await runCleanup(cleanup);
				cleanups.length = 0;
			})();
			return rollbackPromise;
		},
	};
}
