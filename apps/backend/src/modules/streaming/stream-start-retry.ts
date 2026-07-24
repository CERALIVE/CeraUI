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
	readonly launch: (attempt: number) => Promise<void>;
	readonly classifyUnknown: (error: unknown) => StartFailure;
	readonly cancelled: () => boolean;
	readonly onLaunchTimeout: (attempt: number) => Promise<void>;
	readonly setCancelWait: (cancel: (() => void) | undefined) => void;
	readonly schedule: (callback: () => void, delayMs: number) => RetryTimer;
	readonly cancelTimer: (timer: RetryTimer) => void;
	readonly scheduleDeadline: (
		callback: () => void,
		delayMs: number,
	) => RetryTimer;
	readonly cancelDeadline: (timer: RetryTimer) => void;
	readonly cleanupDeadlineMs: number;
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

type LaunchOutcome =
	| { readonly result: "started" }
	| { readonly result: "failed"; readonly error: unknown }
	| { readonly result: "timed_out" }
	| { readonly result: "cleanup_failed" }
	| { readonly result: "cancelled" };

function runLaunchWithinDeadline(
	deps: StartRetryRunDeps,
	attempt: number,
	deadlineMs: number,
): Promise<LaunchOutcome> {
	return new Promise((resolve) => {
		let settled = false;
		let deadlineExpired = false;
		let timer: RetryTimer | undefined;
		let cleanupTimer: RetryTimer | undefined;
		const finish = (outcome: LaunchOutcome): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) deps.cancelDeadline(timer);
			if (cleanupTimer !== undefined) deps.cancelDeadline(cleanupTimer);
			deps.setCancelWait(undefined);
			resolve(outcome);
		};
		const launch = deps.launch(attempt).then<LaunchOutcome, LaunchOutcome>(
			() => ({ result: "started" }),
			(error: unknown) => ({ result: "failed", error }),
		);
		void launch.then((outcome) => {
			if (!deadlineExpired) finish(outcome);
		});
		timer = deps.scheduleDeadline(() => {
			if (settled) return;
			deadlineExpired = true;
			deps.setCancelWait(undefined);
			const cleanup = deps.onLaunchTimeout(attempt).then(
				async () => {
					await launch;
					return true;
				},
				() => false,
			);
			const cleanupDeadline = new Promise<false>((resolveDeadline) => {
				cleanupTimer = deps.scheduleDeadline(
					() => resolveDeadline(false),
					deps.cleanupDeadlineMs,
				);
			});
			void Promise.race([cleanup, cleanupDeadline]).then(
				(cleaned) =>
					finish({
						result: cleaned ? "timed_out" : "cleanup_failed",
					}),
				() => finish({ result: "cleanup_failed" }),
			);
		}, deadlineMs);
		deps.setCancelWait(() => {
			if (settled) return;
			if (timer !== undefined) deps.cancelDeadline(timer);
			deps.setCancelWait(undefined);
		});
	});
}

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
		const remainingBeforeLaunch = Math.max(
			0,
			policy.totalBudgetMs - Math.max(0, now() - startedAt),
		);
		const launch = await runLaunchWithinDeadline(
			deps,
			attempts,
			Math.min(
				policy.attemptTimeoutMs ??
					DEFAULT_START_RETRY_POLICY.attemptTimeoutMs ??
					policy.totalBudgetMs,
				remainingBeforeLaunch,
			),
		);
		if (launch.result === "cancelled" || deps.cancelled()) {
			return { result: "cancelled" };
		}
		if (launch.result === "started") return { result: "started" };
		{
			const error =
				launch.result === "timed_out" || launch.result === "cleanup_failed"
					? new StreamStartFailure({
							attemptId: deps.attemptId,
							phase: "connect",
							class: "start_timeout",
							code:
								launch.result === "timed_out"
									? "start_attempt_deadline"
									: "start_cleanup_timeout",
							retriable: launch.result === "timed_out",
						})
					: launch.error;
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
