import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../../helpers/spawn-policy.ts";
import type { RankedTransport } from "../update-transport/core.ts";
import { UpdateTransferError } from "../update-transport/pin.ts";
import { OsStageError } from "./os-stage-error.ts";
import {
	OS_PIN_HEALTH_POLL_MS,
	OS_PIN_HEALTH_READ_TIMEOUT_MS,
	OS_PIN_HTTPS_FAILURE_THRESHOLD,
	OS_PIN_HTTPS_POLL_MS,
	type OsHttpsHealth,
	type OsPinHealth,
	probePinnedBundle,
	readPinnedTopology,
} from "./os-stage-path.ts";

export const OS_INSTALL_TIMEOUT_MS = 2 * 60 * 60_000;
export type OsStageControl = {
	readonly attemptId: string;
	readonly signal: AbortSignal;
};
export type OsAttemptOutcome =
	| { readonly kind: "succeeded"; readonly result: SpawnWithTimeoutResult }
	| {
			readonly kind: "failed";
			readonly error: OsStageError;
			readonly transfer?: UpdateTransferError;
	  };
export type OsAttemptDeps = {
	readonly run: typeof spawnWithTimeout;
	readonly topology: () => Promise<OsPinHealth>;
	readonly https: () => Promise<OsHttpsHealth>;
	readonly every: (ms: number, action: () => void) => () => void;
};

const every = (ms: number, action: () => void): (() => void) => {
	const timer = setInterval(action, ms);
	timer.unref();
	return () => clearInterval(timer);
};

export function beginOsStageAttempt(
	input: {
		readonly url: string;
		readonly transport: RankedTransport;
		readonly control: OsStageControl;
	},
	overrides: Partial<OsAttemptDeps> = {},
): {
	readonly outcome: Promise<OsAttemptOutcome>;
	readonly cli: Promise<SpawnWithTimeoutResult | Error>;
	readonly cliSettled: () => boolean;
	readonly cliSucceeded?: () => boolean;
	readonly dispose: () => void;
} {
	const deps: OsAttemptDeps = {
		run: spawnWithTimeout,
		topology: () => readPinnedTopology(input.transport),
		https: () => probePinnedBundle(input.url, input.transport),
		every,
		...overrides,
	};
	const local = new AbortController();
	let settled = false;
	let succeeded = false;
	let ended = false;
	let topologyReading = false;
	let httpsReading = false;
	let failures = 0;
	const { promise: outcome, resolve: resolveOutcome } =
		Promise.withResolvers<OsAttemptOutcome>();
	const stops: Array<() => void> = [];
	const dispose = () => {
		for (const stop of stops) stop();
		input.control.signal.removeEventListener("abort", cancel);
	};
	const finish = (result: OsAttemptOutcome) => {
		if (ended) return;
		ended = true;
		dispose();
		resolveOutcome(
			input.control.signal.aborted
				? {
						kind: "failed",
						error: new OsStageError("os_stage_cancelled_for_stream"),
					}
				: result,
		);
		if (result.kind === "failed") local.abort();
	};
	const cancel = () =>
		finish({
			kind: "failed",
			error: new OsStageError("os_stage_cancelled_for_stream"),
		});
	input.control.signal.addEventListener("abort", cancel, { once: true });
	if (input.control.signal.aborted) cancel();
	const cli = ended
		? Promise.resolve<SpawnWithTimeoutResult | Error>(
				new OsStageError("os_stage_cancelled_for_stream"),
			)
		: deps
				.run(["rauc", "install", input.url], {
					timeoutMs: OS_INSTALL_TIMEOUT_MS,
					signal: local.signal,
					onExit: (exitCode) => {
						settled = true;
						succeeded ||= exitCode === 0;
					},
				})
				.then(
					(result) => {
						settled = true;
						succeeded ||= result.exitCode === 0;
						finish(
							result.exitCode === 0
								? { kind: "succeeded", result }
								: {
										kind: "failed",
										error: new OsStageError("rauc_install_failed", {
											cause: result,
										}),
									},
						);
						return result;
					},
					(cause: unknown) => {
						settled = true;
						const error =
							cause instanceof Error ? cause : new Error(String(cause));
						// Only the RAUC boundary owns this overall deadline; it is not a global timeout classifier.
						finish({
							kind: "failed",
							error: new OsStageError("rauc_install_failed", { cause: error }),
						});
						return error;
					},
				);
	if (ended && input.control.signal.aborted) settled = true;
	if (!ended) {
		stops.push(
			deps.every(OS_PIN_HEALTH_POLL_MS, () => {
				if (ended || topologyReading) return;
				topologyReading = true;
				let timer: ReturnType<typeof setTimeout>;
				const unknown = new Promise<OsPinHealth>((resolve) => {
					timer = setTimeout(
						() => resolve({ kind: "unknown" }),
						OS_PIN_HEALTH_READ_TIMEOUT_MS,
					);
				});
				const reading = deps
					.topology()
					.catch((): OsPinHealth => ({ kind: "unknown" }))
					.finally(() => {
						topologyReading = false;
					});
				void Promise.race([reading, unknown])
					.then((health) => {
						if (ended) return;
						if (input.control.signal.aborted) {
							cancel();
							return;
						}
						if (health.kind === "lost") {
							const transfer = new UpdateTransferError("no-route", health);
							finish({
								kind: "failed",
								error: new OsStageError("os_transport_failed", {
									cause: transfer,
									diagnostics: { loss: health.reason },
								}),
								transfer,
							});
						}
					})
					.finally(() => {
						clearTimeout(timer);
					});
			}),
		);
		stops.push(
			deps.every(OS_PIN_HTTPS_POLL_MS, () => {
				if (ended || httpsReading) return;
				httpsReading = true;
				void deps
					.https()
					.then((health) => {
						if (ended) return;
						if (input.control.signal.aborted) {
							cancel();
							return;
						}
						switch (health.kind) {
							case "transport":
								if (++failures >= OS_PIN_HTTPS_FAILURE_THRESHOLD)
									finish({
										kind: "failed",
										error: new OsStageError("os_transport_failed", {
											cause: health.error,
										}),
										transfer: health.error,
									});
								return;
							case "origin":
								finish({
									kind: "failed",
									error: new OsStageError("os_origin_unavailable", {
										diagnostics: { status: health.status },
									}),
								});
								return;
							case "healthy":
							case "unavailable":
								failures = 0;
								return;
							default: {
								const unreachable: never = health;
								return unreachable;
							}
						}
					})
					.catch(() => {
						failures = 0;
					})
					.finally(() => {
						httpsReading = false;
					});
			}),
		);
	}
	return {
		outcome,
		cli,
		cliSettled: () => settled,
		cliSucceeded: () => succeeded,
		dispose,
	};
}
