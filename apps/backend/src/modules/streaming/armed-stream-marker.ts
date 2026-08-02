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
 * The ARMED-STREAM MARKER and the PURE gate table that reads it.
 *
 * A stream that was live when the engine was SIGKILLed used to end there:
 * `noteConnectionLoss` retires the session, systemd restarts cerastream, and
 * nobody ever tries again. Wave3 measured that at 0/6 stream-level resumptions.
 * This module holds the one piece of durable state that makes a single,
 * boot-scoped, one-shot restoration possible — and, more importantly, the gate
 * table that decides when it must NOT happen.
 *
 * It is deliberately dependency-light (fs + zod + the logger) so it can be
 * imported from anywhere in the streaming graph without reordering module
 * initialisation. The wiring that reads `config.json`, drives the engine and
 * publishes events lives in `stream-restoration.ts`.
 *
 * THE ENGINE SESSION ID IS DIAGNOSTIC ONLY, AND THAT IS NOT A STYLE CHOICE.
 * Four independent facts make it unusable as a gate, each verified against the
 * current code rather than inherited from the plan text:
 *
 *   1. the adoption seam answers `"streaming" | "idle" | "unknown"` and nothing
 *      else (`streaming-backend.ts` `EngineRuntimeState`, consumed by
 *      `reconcileRuntimeState()`), so a session identity never reaches CeraUI
 *      through the one call that could act on it;
 *   2. `CerastreamBackend.start()` parses the engine's start reply for its
 *      `state` alone and drops the rest — no `session_id` is retained anywhere;
 *   3. the engine's `status` events carry no session identity either, so the
 *      long-lived subscription cannot supply one; and
 *   4. the engine's own ids are process-local counters, so a restarted engine
 *      re-issues the SAME id for a DIFFERENT session — comparing them would be
 *      worse than not comparing them.
 *
 * So `diagnostics.engineSessionId` is written when we happen to know it and is
 * never read by `decideStreamRestoration`. Do not promote it to a gate.
 *
 * TWO MARKERS COEXIST HERE. `config.inflight.json` (todo 14) records an
 * apply-now config transaction; `stream.armed.json` records that a stream was
 * live. They are different files, different schemas and different lifetimes,
 * and neither reads the other — a device can legitimately hold both at once
 * (an engine that died mid apply-now), and each must be judged on its own.
 */

import fs from "node:fs";

import {
	audioCodecSchema,
	inputModeSchema,
	type LifecycleState,
} from "@ceraui/rpc/schemas";
import { z } from "zod";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import {
	framerateSchema,
	relayProtocolSchema,
	resolutionSchema,
	videoCodecSchema,
	videoPassthroughSchema,
} from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import type { EngineRuntimeState } from "./streaming-backend.ts";

export const ARMED_STREAM_MARKER_FILE = "stream.armed.json";

/**
 * Where the kernel publishes the identity of the current boot. It changes on
 * every power cycle and reboot and on nothing else, which is exactly the
 * question the marker has to answer: "is this the same boot the stream was
 * live in?".
 */
export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/**
 * The stream-defining slice of the runtime config — everything a launch reads,
 * and NOTHING else. Credentials (`password_hash`, `ssh_pass`, `remote_key`, the
 * pairing seed) are deliberately absent: this file exists to restart a stream,
 * not to become a second copy of the secret store.
 */
const armedStreamConfigSchema = z.object({
	delay: z.number().optional(),
	srt_latency: z.number().optional(),
	pipeline: z.string().optional(),
	acodec: audioCodecSchema.optional(),
	asrc: z.string().optional(),
	relay_server: z.string().optional(),
	relay_account: z.string().optional(),
	relay_streamid_override: z.string().optional(),
	relay_protocol: relayProtocolSchema.optional(),
	srtla_addr: z.string().optional(),
	srtla_port: z.number().optional(),
	srt_streamid: z.string().optional(),
	selected_ingest_endpoint: z.string().optional(),
	max_br: z.number().optional(),
	resolution: resolutionSchema.optional(),
	framerate: framerateSchema.optional(),
	video_codec: videoCodecSchema.optional(),
	video_passthrough: videoPassthroughSchema.optional(),
	source: z.string().optional(),
	source_stable_id: z.string().optional(),
	selected_video_input: z.string().optional(),
	input_mode: inputModeSchema.optional(),
});
export type ArmedStreamConfig = z.infer<typeof armedStreamConfigSchema>;

/** Why a stop was issued. `operator` is the ONLY cause that clears the marker. */
export const STREAM_STOP_CAUSES = [
	"operator",
	"engine_loss",
	"reconfigure",
] as const;
export type StreamStopCause = (typeof STREAM_STOP_CAUSES)[number];

/** Why a restoration could not be attempted, or attempted and did not land. */
export const RECOVERY_FAILURE_REASONS = [
	"runtime_state_unknown",
	"lifecycle_busy",
	"config_invalid",
	"start_failed",
	"start_busy",
	"start_cancelled",
] as const;
export type RecoveryFailureReason = (typeof RECOVERY_FAILURE_REASONS)[number];

const recoveryFailureReasonSchema = z.enum(RECOVERY_FAILURE_REASONS);

/**
 * The terminal attempted-state. Its PRESENCE — not its outcome — is the
 * one-shot guarantee: a marker that carries an attempt can never be attempted
 * again, so no number of backend restarts turns this into a retry loop.
 */
const restorationAttemptSchema = z.object({
	outcome: z.enum(["recovered", "failed"]),
	reason: recoveryFailureReasonSchema.optional(),
	at: z.number(),
	/**
	 * Milliseconds from the reconnect event that triggered the run to the
	 * outcome, recorded against the DECLARED 30 s restoration bound. Recorded
	 * on every attempt, in both directions, so the bound is judged from
	 * evidence rather than asserted.
	 */
	elapsedMs: z.number(),
	withinBound: z.boolean(),
});
export type RestorationAttempt = z.infer<typeof restorationAttemptSchema>;

const armedStreamMarkerSchema = z.object({
	armedAt: z.number(),
	bootId: z.string().min(1),
	config: armedStreamConfigSchema,
	/**
	 * Recorded because it is useful in a journal, and read by NOTHING. See the
	 * module header for why the engine session id cannot gate anything.
	 */
	diagnostics: z
		.object({
			attemptId: z.string().optional(),
			origin: z.string().optional(),
			engineSessionId: z.string().optional(),
		})
		.optional(),
	/** Set by an OTA/update/shutdown path; suppresses restoration outright. */
	plannedShutdown: z.object({ reason: z.string(), at: z.number() }).optional(),
	attempt: restorationAttemptSchema.optional(),
});
export type ArmedStreamMarker = z.infer<typeof armedStreamMarkerSchema>;

/** File I/O seam — mirrors `config-change-staging.ts` `StagingDeps`. */
export type ArmedStreamMarkerDeps = {
	readonly markerPath: string;
	readonly readMarker: (path: string) => string | undefined;
	readonly writeMarker: (path: string, contents: string) => void;
	readonly removeMarker: (path: string) => void;
	readonly readBootId: () => string | undefined;
};

export function readSystemBootId(
	path: string = BOOT_ID_PATH,
): string | undefined {
	try {
		const raw = fs.readFileSync(path, "utf8").trim();
		return raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}

export const defaultArmedStreamMarkerDeps: ArmedStreamMarkerDeps = {
	markerPath: ARMED_STREAM_MARKER_FILE,
	readMarker: (path) => {
		try {
			return fs.readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	writeMarker: writeFileAtomicSync,
	removeMarker: (path) => {
		try {
			fs.unlinkSync(path);
		} catch {
			// Already gone — clearing an absent marker is the desired end state.
		}
	},
	readBootId: () => readSystemBootId(),
};

export function readArmedStreamMarker(
	deps: ArmedStreamMarkerDeps = defaultArmedStreamMarkerDeps,
): ArmedStreamMarker | undefined {
	const raw = deps.readMarker(deps.markerPath);
	if (raw === undefined) return undefined;
	try {
		return armedStreamMarkerSchema.parse(JSON.parse(raw));
	} catch (err) {
		logger.warn("discarding an unreadable armed-stream marker", { err });
		deps.removeMarker(deps.markerPath);
		return undefined;
	}
}

export function writeArmedStreamMarker(
	marker: ArmedStreamMarker,
	deps: ArmedStreamMarkerDeps = defaultArmedStreamMarkerDeps,
): void {
	try {
		// Parsed on WRITE, not just on read: the snapshot is built by copying from
		// the runtime config, and that config also holds `password_hash`,
		// `ssh_pass` and `remote_key`. Zod strips everything outside the declared
		// shape, so a future copy-loop mistake cannot put a credential on disk.
		deps.writeMarker(
			deps.markerPath,
			JSON.stringify(armedStreamMarkerSchema.parse(marker)),
		);
	} catch (err) {
		// A stream that is live must never fail because its recovery hint could
		// not be written. The worst case is the pre-existing behaviour: an engine
		// death ends the session and nothing restores it.
		logger.warn("could not write the armed-stream marker", { err });
	}
}

export function clearArmedStreamMarker(
	deps: ArmedStreamMarkerDeps = defaultArmedStreamMarkerDeps,
): void {
	deps.removeMarker(deps.markerPath);
}

/**
 * Apply a stop's CAUSE to the marker. Only an operator Stop clears it — an
 * engine loss and a reconfigure restart both leave a live stream's intent
 * standing, which is exactly what makes them recoverable.
 */
export function noteStreamStopped(
	cause: StreamStopCause,
	deps: ArmedStreamMarkerDeps = defaultArmedStreamMarkerDeps,
): void {
	if (cause !== "operator") return;
	clearArmedStreamMarker(deps);
}

/**
 * Suppress restoration for a shutdown the device is performing on purpose.
 *
 * It is stamped ONTO the marker rather than kept as a standalone flag file so it
 * can never outlive the thing it suppresses: no armed stream means nothing to
 * write, and the next armed stream starts from a clean marker. A separate flag
 * would need its own clearing rule, and getting that wrong disables restoration
 * permanently and silently.
 */
export function notePlannedShutdown(
	reason: string,
	options: {
		readonly marker?: ArmedStreamMarkerDeps;
		readonly now?: () => number;
	} = {},
): boolean {
	const deps = options.marker ?? defaultArmedStreamMarkerDeps;
	const marker = readArmedStreamMarker(deps);
	if (marker === undefined) return false;
	if (marker.plannedShutdown !== undefined) return true;
	writeArmedStreamMarker(
		{ ...marker, plannedShutdown: { reason, at: (options.now ?? Date.now)() } },
		deps,
	);
	logger.warn("stream restoration suppressed by a planned shutdown", {
		module: "streaming",
		reason,
	});
	return true;
}

/** Every reason the gate refuses to restore WITHOUT having tried. */
export const RESTORATION_BLOCKED_REASONS = [
	"no_marker",
	"already_attempted",
	"planned_shutdown",
	"boot_id_mismatch",
] as const;
export type RestorationBlockedReason =
	(typeof RESTORATION_BLOCKED_REASONS)[number];

export type RestorationDecision =
	/** The engine is running a session — adopt it, and never restore. */
	| { readonly action: "adopt" }
	/** Every gate holds; launch exactly one attempt. */
	| { readonly action: "restore" }
	/** Not yet decidable; poll again inside the sub-deadline. */
	| { readonly action: "wait"; readonly reason: RecoveryFailureReason }
	/** Decidably ineligible; nothing is written, nothing is attempted. */
	| { readonly action: "blocked"; readonly reason: RestorationBlockedReason }
	/** The sub-deadline expired without a decisive answer — terminal. */
	| { readonly action: "give_up"; readonly reason: RecoveryFailureReason };

/**
 * How long an UNDECIDED runtime state may be polled before the attempt is
 * written off. The engine answers `unknown` both while it is down and while a
 * probe is transitional, so this is the window a systemd-restarted cerastream
 * has to come back and say something authoritative.
 */
export const RESTORATION_UNKNOWN_DEADLINE_MS = 10_000;
/** Poll cadence inside that window — the orchestrator's own reconcile cadence. */
export const RESTORATION_POLL_MS = 1_000;
/**
 * The DECLARED restoration bound: outcome-gated advancing frames within 30 s of
 * the reconnect event that triggered the run. It is RECORDED per attempt rather
 * than enforced as a second deadline — the launch already owns its own bounded
 * retry machinery, and racing a competing timer against it would report a
 * healthy-but-slow start as a failure.
 */
export const RESTORATION_BOUND_MS = 30_000;

/**
 * The whole gate table, PURE, so every condition can be flipped on its own.
 *
 * Ordering carries the two safety properties:
 *
 * ADOPTION WINS, UNCONDITIONALLY AND FIRST. A backend-only restart leaves the
 * engine streaming; asking about the marker before asking about the engine is
 * how a device ends up with two sessions. The runtime-state check therefore
 * runs ahead of every marker gate and short-circuits.
 *
 * A DECIDABLE REFUSAL OUTRANKS AN UNDECIDED STATE. `already_attempted`,
 * `planned_shutdown` and `boot_id_mismatch` are permanent facts, so they are
 * settled before the loop is allowed to spend its sub-deadline polling a state
 * whose answer could not change the outcome anyway.
 */
export function decideStreamRestoration(input: {
	readonly marker: ArmedStreamMarker | undefined;
	readonly runtimeState: EngineRuntimeState;
	readonly lifecycleState: LifecycleState;
	readonly currentBootId: string | undefined;
	readonly elapsedMs: number;
	readonly unknownDeadlineMs?: number;
}): RestorationDecision {
	if (input.runtimeState === "streaming") return { action: "adopt" };

	const marker = input.marker;
	if (marker === undefined) return { action: "blocked", reason: "no_marker" };
	if (marker.attempt !== undefined)
		return { action: "blocked", reason: "already_attempted" };
	if (marker.plannedShutdown !== undefined)
		return { action: "blocked", reason: "planned_shutdown" };
	// An absent boot id is treated exactly like a mismatched one: we cannot
	// PROVE this is the same boot, and "never auto-restart across a reboot" is
	// only a guarantee if the unprovable case fails closed.
	if (
		input.currentBootId === undefined ||
		marker.bootId !== input.currentBootId
	)
		return { action: "blocked", reason: "boot_id_mismatch" };

	const deadline = input.unknownDeadlineMs ?? RESTORATION_UNKNOWN_DEADLINE_MS;
	const expired = input.elapsedMs >= deadline;

	if (input.runtimeState === "unknown")
		return expired
			? { action: "give_up", reason: "runtime_state_unknown" }
			: { action: "wait", reason: "runtime_state_unknown" };

	// The engine is authoritatively idle, but our own lifecycle may still own the
	// slot — a config-change transaction settling, a stop finishing, a reconcile
	// in flight. Restoration waits behind it rather than racing it.
	if (input.lifecycleState !== "idle")
		return expired
			? { action: "give_up", reason: "lifecycle_busy" }
			: { action: "wait", reason: "lifecycle_busy" };

	return { action: "restore" };
}

/** Fold an outcome into the terminal attempted-state written onto the marker. */
export function buildRestorationAttempt(input: {
	readonly outcome: "recovered" | "failed";
	readonly reason?: RecoveryFailureReason;
	readonly at: number;
	readonly elapsedMs: number;
}): RestorationAttempt {
	return {
		outcome: input.outcome,
		...(input.reason === undefined ? {} : { reason: input.reason }),
		at: input.at,
		elapsedMs: input.elapsedMs,
		withinBound: input.elapsedMs <= RESTORATION_BOUND_MS,
	};
}
