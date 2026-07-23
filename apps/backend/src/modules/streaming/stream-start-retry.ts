import type {
	StartFailure,
	StartFailureClass,
	StartFailurePhase,
} from "@ceraui/rpc/schemas";

import {
	DEFAULT_START_RETRY_POLICY,
	nextBackoffDelayMs,
	type RetryPolicy,
	StreamStartFailure,
	type SuppressionContext,
	shouldRetryStart,
	shouldSuppressTransientFailure,
} from "./start-failure-taxonomy.ts";

type RetryTimer = ReturnType<typeof globalThis.setTimeout> | number;

export type StartRetryDiagnostic = {
	readonly attemptId: string;
	readonly phase: StartFailurePhase;
	readonly class: StartFailureClass;
	readonly code?: number | string;
	readonly retry:
		| {
				readonly state: "scheduled";
				readonly attempt: number;
				readonly nextAttempt: number;
				readonly maxAttempts: number;
				readonly delayMs: number;
				readonly suppressed: boolean;
		  }
		| {
				readonly state: "exhausted" | "not_retriable";
				readonly attempt: number;
				readonly maxAttempts: number;
				readonly suppressed: false;
		  };
};

export type StartRetryRunResult =
	| { readonly result: "started" }
	| { readonly result: "cancelled" }
	| { readonly result: "failed"; readonly failure: StartFailure };

export type StartRetryRunDeps = {
	readonly attemptId: string;
	readonly launch: () => Promise<void>;
	readonly classifyUnknown: (error: unknown) => StartFailure;
	readonly cancelled: () => boolean;
	readonly setCancelWait: (cancel: (() => void) | undefined) => void;
	readonly schedule: (callback: () => void, delayMs: number) => RetryTimer;
	readonly cancelTimer: (timer: RetryTimer) => void;
	readonly retryPolicy?: RetryPolicy;
	readonly now?: () => number;
	readonly suppressionContext?: () => SuppressionContext;
	readonly reportRetry?: (diagnostic: StartRetryDiagnostic) => void;
	readonly reportTerminalFailure?: (diagnostic: StartRetryDiagnostic) => void;
};

const NO_SUPPRESSION: SuppressionContext = {
	softwareUpdateActive: false,
	engineRestartWindow: false,
	bootWindow: false,
	cancelledByStop: false,
};

function waitForRetry(
	deps: StartRetryRunDeps,
	delayMs: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (elapsed: boolean): void => {
			if (settled) return;
			settled = true;
			deps.setCancelWait(undefined);
			resolve(elapsed);
		};
		const timer = deps.schedule(() => finish(true), delayMs);
		deps.setCancelWait(() => {
			deps.cancelTimer(timer);
			finish(false);
		});
	});
}

function diagnostic(
	failure: StartFailure,
	retry: StartRetryDiagnostic["retry"],
): StartRetryDiagnostic {
	return {
		attemptId: failure.attemptId,
		phase: failure.phase,
		class: failure.class,
		...(failure.code !== undefined ? { code: failure.code } : {}),
		retry,
	};
}

export async function runStartWithRetry(
	deps: StartRetryRunDeps,
): Promise<StartRetryRunResult> {
	const policy = deps.retryPolicy ?? DEFAULT_START_RETRY_POLICY;
	const now = deps.now ?? Date.now;
	const startedAt = now();
	let attempts = 0;

	while (true) {
		attempts += 1;
		try {
			await deps.launch();
			return deps.cancelled() ? { result: "cancelled" } : { result: "started" };
		} catch (error) {
			if (deps.cancelled()) return { result: "cancelled" };
			const classified =
				error instanceof StreamStartFailure
					? error.failure
					: deps.classifyUnknown(error);
			const suppression = deps.suppressionContext?.() ?? NO_SUPPRESSION;
			const failure: StartFailure =
				suppression.engineRestartWindow &&
				classified.class === "engine_unavailable"
					? { ...classified, class: "engine_restarting" }
					: classified;
			const elapsedMs = Math.max(0, now() - startedAt);
			const delayMs = nextBackoffDelayMs(attempts - 1, policy);
			const remainingMs = policy.totalBudgetMs - elapsedMs;

			if (
				shouldRetryStart(failure, { attempts, elapsedMs }, policy) &&
				delayMs < remainingMs
			) {
				deps.reportRetry?.(
					diagnostic(failure, {
						state: "scheduled",
						attempt: attempts,
						nextAttempt: attempts + 1,
						maxAttempts: policy.maxAttempts,
						delayMs,
						suppressed: shouldSuppressTransientFailure(suppression),
					}),
				);
				if (!(await waitForRetry(deps, delayMs))) {
					return { result: "cancelled" };
				}
				continue;
			}

			deps.reportTerminalFailure?.(
				diagnostic(failure, {
					state: failure.retriable ? "exhausted" : "not_retriable",
					attempt: attempts,
					maxAttempts: policy.maxAttempts,
					suppressed: false,
				}),
			);
			return { result: "failed", failure };
		}
	}
}
