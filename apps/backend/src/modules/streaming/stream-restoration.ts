/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * ONE-SHOT STREAM RESTORATION — the production wiring around the pure gate table
 * in `armed-stream-marker.ts`.
 *
 * It owns four things the gate deliberately does not: WHERE the marker's config
 * snapshot comes from, WHEN a run is triggered, HOW the single restart attempt
 * is launched, and WHAT the operator is told about it.
 *
 * ONE-SHOT IS THE FEATURE, NOT A LIMITATION. Both outcomes — recovered and
 * failed — write a terminal attempted-state onto the marker before anything
 * else, so the answer to "what happens if the backend restarts again" is always
 * "nothing". There is no retry, no backoff, and no second chance; a device that
 * cannot restore its stream lands in an honest `idle` with a published reason
 * rather than in a loop nobody asked for.
 *
 * ADOPTION ALWAYS BEATS RESTORATION. The runtime-state check runs first and
 * short-circuits, so a backend-only restart against a still-streaming engine
 * adopts that session and never launches a second one. That is the whole reason
 * the check is not "did we leave a marker behind" — a marker survives a backend
 * restart exactly as it survives an engine death, and only the engine can say
 * which of the two happened.
 *
 * THE RUN IS SELF-SERIALISING. Three seams trigger it — the engine-loss
 * retirement, backend boot, and the engine-reconnect heal — and they overlap in
 * practice. A second caller JOINS the in-flight run instead of racing it, which
 * is what makes a repeatedly-firing reconnect hook harmless.
 */

import type { LifecycleState } from "@ceraui/rpc/schemas";

import { logger as defaultLogger } from "../../helpers/logger.ts";
import { getConfig } from "../config.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import {
	type ArmedStreamConfig,
	type ArmedStreamMarker,
	type ArmedStreamMarkerDeps,
	buildRestorationAttempt,
	clearArmedStreamMarker,
	decideStreamRestoration,
	defaultArmedStreamMarkerDeps,
	RESTORATION_BOUND_MS,
	RESTORATION_POLL_MS,
	RESTORATION_UNKNOWN_DEADLINE_MS,
	type RecoveryFailureReason,
	readArmedStreamMarker,
	writeArmedStreamMarker,
} from "./armed-stream-marker.ts";
import { queryEngineRuntimeStreaming } from "./engine-runtime-state.ts";
import { awaitRecoveryBarrier } from "./recovery-barrier.ts";
import { getStreamSessionSnapshot } from "./stream-session-orchestrator.ts";
import type { EngineRuntimeState } from "./streaming-backend.ts";

/**
 * The stream-defining slice of the live config, captured verbatim.
 *
 * It is the RUNNING configuration, which is not the same thing as `config.json`:
 * a save with no `apply_now` writes a restart-requiring field to disk while the
 * engine keeps encoding the previous one. Restoring from disk would therefore
 * apply an edit the operator explicitly deferred to their next start. The
 * snapshot is what makes restoration restore the stream that was interrupted.
 */
export function captureArmedStreamConfig(): ArmedStreamConfig {
	const config = getConfig();
	const snapshot: Record<string, unknown> = {};
	const copy = (key: keyof ArmedStreamConfig): void => {
		const value = (config as unknown as Record<string, unknown>)[key];
		if (value !== undefined) snapshot[key] = value;
	};
	copy("delay");
	copy("srt_latency");
	copy("pipeline");
	copy("acodec");
	copy("asrc");
	copy("relay_server");
	copy("relay_account");
	copy("relay_streamid_override");
	copy("relay_protocol");
	copy("srtla_addr");
	copy("srtla_port");
	copy("srt_streamid");
	copy("selected_ingest_endpoint");
	copy("max_br");
	copy("resolution");
	copy("framerate");
	copy("video_codec");
	copy("video_passthrough");
	copy("source");
	copy("source_stable_id");
	copy("selected_video_input");
	copy("input_mode");
	return snapshot as ArmedStreamConfig;
}

export type ArmRestorationOptions = {
	readonly marker?: ArmedStreamMarkerDeps;
	readonly captureConfig?: () => ArmedStreamConfig;
	readonly now?: () => number;
	readonly diagnostics?: ArmedStreamMarker["diagnostics"];
};

/**
 * Arm the marker at the engine's own outcome gate. Called from the orchestrator's
 * `transition("streaming")` commit point — the single moment a start is known to
 * have really delivered — and from nowhere else.
 *
 * A boot id we cannot read means we could not later PROVE the device had not
 * rebooted, so nothing is armed at all. Failing closed here costs a restoration;
 * failing open would auto-restart a stream across a power cycle.
 */
export function armStreamRestoration(
	options: ArmRestorationOptions = {},
): boolean {
	const deps = options.marker ?? defaultArmedStreamMarkerDeps;
	const bootId = deps.readBootId();
	if (bootId === undefined) {
		defaultLogger.warn(
			"stream restoration: no boot id available; the session is not armed",
		);
		return false;
	}
	const capture = options.captureConfig ?? captureArmedStreamConfig;
	const now = options.now ?? Date.now;
	writeArmedStreamMarker(
		{
			armedAt: now(),
			bootId,
			config: capture(),
			...(options.diagnostics === undefined
				? {}
				: { diagnostics: options.diagnostics }),
		},
		deps,
	);
	return true;
}

export type RestorationLaunchOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: RecoveryFailureReason };

export type RestorationRunOutcome =
	| { readonly result: "adopted" }
	| { readonly result: "blocked"; readonly reason: string }
	| { readonly result: "recovered"; readonly elapsedMs: number }
	| {
			readonly result: "failed";
			readonly reason: RecoveryFailureReason;
			readonly elapsedMs: number;
	  };

export interface RestorationLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

export interface StreamRestorationDeps {
	readonly marker: ArmedStreamMarkerDeps;
	readonly runtimeState: () => Promise<EngineRuntimeState>;
	readonly lifecycleState: () => LifecycleState;
	readonly launch: (
		config: ArmedStreamConfig,
	) => Promise<RestorationLaunchOutcome>;
	readonly publish: (outcome: RestorationRunOutcome) => void;
	readonly wait: (ms: number) => Promise<void>;
	readonly now: () => number;
	readonly logger: RestorationLogger;
	readonly pollIntervalMs: number;
	readonly unknownDeadlineMs: number;
	/**
	 * Resolves once modem-mutation replay has finished. It is awaited BEFORE the
	 * marker is read, not merely before the launch: this path terminalizes its
	 * one-shot marker on an unhandled refusal, so judging a marker against a
	 * half-recovered device would spend the single restoration attempt on a
	 * verdict the recovery was about to change.
	 */
	readonly awaitRecovery: () => Promise<void>;
}

/**
 * Launch the single restart attempt with the marker's snapshot.
 *
 * Every collaborator is imported lazily for the module-ordering reason the rest
 * of this graph documents: the launch path reaches `sources.ts`, which is
 * upstream of the orchestrator that imports this module.
 */
async function defaultLaunch(
	config: ArmedStreamConfig,
): Promise<RestorationLaunchOutcome> {
	const [
		{ validateConfig },
		{ resolveSrtla },
		{ prepareSrtlaIpAddresses },
		{ startStream },
		{ startStreamSession },
		{ StreamStartFailure, classifyStartFailure, typedStartFailure },
	] = await Promise.all([
		import("./streaming.ts"),
		import("./srtla.ts"),
		import("./streamloop/session.ts"),
		import("./streamloop/start-stream.ts"),
		import("./stream-session-orchestrator.ts"),
		import("./start-failure-taxonomy.ts"),
	]);

	let resolved: Awaited<ReturnType<typeof validateConfig>>;
	try {
		resolved = await validateConfig({ ...config });
		await prepareSrtlaIpAddresses(resolved.srtlaAddr);
	} catch (error) {
		defaultLogger.warn("stream restoration: the saved config is not usable", {
			error,
		});
		return { ok: false, reason: "config_invalid" };
	}

	const result = await startStreamSession({
		origin: "restoration",
		launch: async ({ attemptId }) => {
			const srtlaAddr = await resolveSrtla(resolved.srtlaAddr);
			const launched = await startStream(
				resolved.pipeline,
				srtlaAddr,
				resolved.srtlaPort,
				resolved.streamid,
				{},
				attemptId,
				config,
			);
			if (!launched.success) {
				throw new StreamStartFailure(
					launched.failureClass !== undefined
						? typedStartFailure(
								attemptId,
								launched.phase,
								launched.failureClass,
								launched.error,
							)
						: classifyStartFailure(launched.phase, launched.error, attemptId),
				);
			}
		},
	});

	if (result.result === "started") return { ok: true };
	if (result.result === "busy") return { ok: false, reason: "start_busy" };
	if (result.result === "cancelled")
		return { ok: false, reason: "start_cancelled" };
	return { ok: false, reason: "start_failed" };
}

function defaultPublish(outcome: RestorationRunOutcome): void {
	if (outcome.result === "recovered") {
		notificationBroadcast(
			"stream_recovered",
			"success",
			"The stream was restored after the streaming engine restarted.",
			10,
			false,
			true,
			true,
			"notifications.streamRecovered",
			{ elapsedMs: outcome.elapsedMs },
		);
		return;
	}
	if (outcome.result !== "failed") return;
	notificationBroadcast(
		"stream_recovery_failed",
		"error",
		"The stream could not be restored after the streaming engine restarted. Open Settings → System Logs for details.",
		0,
		true,
		true,
		true,
		"notifications.streamRecoveryFailed",
		{ reason: outcome.reason },
	);
}

function defaultDeps(): StreamRestorationDeps {
	return {
		marker: defaultArmedStreamMarkerDeps,
		runtimeState: queryEngineRuntimeStreaming,
		lifecycleState: () => getStreamSessionSnapshot().state,
		launch: defaultLaunch,
		publish: defaultPublish,
		wait: (ms) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms);
			}),
		now: Date.now,
		logger: defaultLogger,
		pollIntervalMs: RESTORATION_POLL_MS,
		unknownDeadlineMs: RESTORATION_UNKNOWN_DEADLINE_MS,
		awaitRecovery: awaitRecoveryBarrier,
	};
}

/**
 * Retire the marker we JUDGED — and only that one.
 *
 * A successful restoration commits a new session, and that commit arms a FRESH
 * marker through the ordinary outcome gate. Stamping the terminal attempt on top
 * of it would retire a marker describing a stream that is live right now, so the
 * NEXT engine death would find an already-attempted marker and give up. Measured
 * on a board: SIGKILL #1 restored in 11.5 s, #2 and #3 did nothing at all.
 *
 * `armedAt` is the compare-and-set token — same shape as the source-selection
 * write token. A failed attempt commits nothing, so nothing re-arms, so the
 * terminal state lands exactly as before.
 */
function recordAttempt(
	deps: StreamRestorationDeps,
	judged: ArmedStreamMarker,
	outcome: "recovered" | "failed",
	elapsedMs: number,
	reason?: RecoveryFailureReason,
): void {
	const current = readArmedStreamMarker(deps.marker);
	if (current === undefined || current.armedAt !== judged.armedAt) return;
	writeArmedStreamMarker(
		{
			...current,
			attempt: buildRestorationAttempt({
				outcome,
				...(reason === undefined ? {} : { reason }),
				at: deps.now(),
				elapsedMs,
			}),
		},
		deps.marker,
	);
}

let inflight: Promise<RestorationRunOutcome> | undefined;

async function runOnce(
	deps: StreamRestorationDeps,
): Promise<RestorationRunOutcome> {
	await deps.awaitRecovery();
	const startedAt = deps.now();
	for (;;) {
		const marker = readArmedStreamMarker(deps.marker);
		const decision = decideStreamRestoration({
			marker,
			runtimeState: await deps.runtimeState(),
			lifecycleState: deps.lifecycleState(),
			currentBootId: deps.marker.readBootId(),
			elapsedMs: deps.now() - startedAt,
			unknownDeadlineMs: deps.unknownDeadlineMs,
		});

		if (decision.action === "adopt") {
			deps.logger.info(
				"stream restoration: the engine is already streaming — adopted, not restored",
			);
			return { result: "adopted" };
		}

		if (decision.action === "blocked") {
			// A marker from a previous boot can never become eligible again, so it
			// is retired rather than left to be re-judged on every reconnect.
			if (decision.reason === "boot_id_mismatch") {
				clearArmedStreamMarker(deps.marker);
			}
			if (decision.reason !== "no_marker") {
				deps.logger.warn("stream restoration blocked", {
					module: "streaming",
					reason: decision.reason,
				});
			}
			return { result: "blocked", reason: decision.reason };
		}

		if (decision.action === "wait") {
			await deps.wait(deps.pollIntervalMs);
			continue;
		}

		const elapsedMs = deps.now() - startedAt;
		if (decision.action === "give_up") {
			if (marker !== undefined)
				recordAttempt(deps, marker, "failed", elapsedMs, decision.reason);
			deps.logger.warn("stream restoration gave up", {
				module: "streaming",
				reason: decision.reason,
				elapsedMs,
			});
			const outcome = {
				result: "failed",
				reason: decision.reason,
				elapsedMs,
			} as const;
			deps.publish(outcome);
			return outcome;
		}

		if (marker === undefined) return { result: "blocked", reason: "no_marker" };

		const launched = await deps.launch(marker.config);
		const attemptElapsedMs = deps.now() - startedAt;
		if (launched.ok) {
			recordAttempt(deps, marker, "recovered", attemptElapsedMs);
			deps.logger.warn("stream restored after an engine restart", {
				module: "streaming",
				elapsedMs: attemptElapsedMs,
				boundMs: RESTORATION_BOUND_MS,
				withinBound: attemptElapsedMs <= RESTORATION_BOUND_MS,
			});
			const outcome = {
				result: "recovered",
				elapsedMs: attemptElapsedMs,
			} as const;
			deps.publish(outcome);
			return outcome;
		}

		recordAttempt(deps, marker, "failed", attemptElapsedMs, launched.reason);
		deps.logger.warn("stream restoration attempt failed", {
			module: "streaming",
			reason: launched.reason,
			elapsedMs: attemptElapsedMs,
		});
		const outcome = {
			result: "failed",
			reason: launched.reason,
			elapsedMs: attemptElapsedMs,
		} as const;
		deps.publish(outcome);
		return outcome;
	}
}

/**
 * Judge an armed-stream marker against the engine's current truth and, when
 * every gate holds, launch exactly one restart.
 *
 * Fail-soft by contract: it never throws, so a boot/reconnect/engine-loss hook
 * can call it without a guard of its own.
 */
export function runStreamRestoration(
	overrides: Partial<StreamRestorationDeps> = {},
): Promise<RestorationRunOutcome> {
	if (inflight !== undefined) return inflight;
	const deps: StreamRestorationDeps = { ...defaultDeps(), ...overrides };

	const run = runOnce(deps)
		.catch((err: unknown): RestorationRunOutcome => {
			// Leaving the marker untouched is the safe end state: an un-judged
			// marker is re-judged on the next reconnect, whereas a half-written
			// terminal state would silently forfeit the one attempt.
			deps.logger.warn("stream restoration run failed", {
				module: "streaming",
				err,
			});
			return { result: "blocked", reason: "run_failed" };
		})
		.finally(() => {
			inflight = undefined;
		});

	inflight = run;
	return run;
}

/** Test/teardown seam: resolve once the in-flight run has settled. */
export function settleStreamRestoration(): Promise<unknown> {
	return inflight ?? Promise.resolve();
}
