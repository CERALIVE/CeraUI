import fs from "node:fs";
import { compositionConfigSchema } from "@ceralive/cerastream";

import {
	inputModeSchema,
	normalizeFramerateToRung,
	normalizeResolutionToRung,
	videoCodecSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";

export const INFLIGHT_MARKER_FILE = "config.inflight.json";

const stagedFieldsSchema = z.object({
	composition: compositionConfigSchema.nullable().optional(),
	source: z.string().optional(),
	pipeline: z.string().optional(),
	selected_video_input: z.string().optional(),
	// `null` is the local storage clear a source switch derives for an override
	// the destination pipeline cannot honor — never a value sent to the engine.
	resolution: z.string().nullable().optional(),
	framerate: z.number().nullable().optional(),
	video_codec: videoCodecSchema.optional(),
	// Switching a dual-format camera between H.264 and MJPEG rebuilds the capture
	// leg, so it is a transaction like the axes above — never a live reload.
	// `null` is the clear a switch to a different camera makes, as for composition.
	input_mode: inputModeSchema.nullable().optional(),
});
export type StagedConfigFields = z.infer<typeof stagedFieldsSchema>;

/**
 * What the candidate must beat: concrete geometry only. A `null` clear exists
 * only in a candidate, never in the state that was running before it.
 */
const previousFieldsSchema = stagedFieldsSchema
	.omit({ resolution: true, framerate: true })
	.extend({
		resolution: z.string().optional(),
		framerate: z.number().optional(),
	});
export type PreviousConfigFields = z.infer<typeof previousFieldsSchema>;

const inflightMarkerSchema = z.object({
	attemptId: z.string(),
	startedAt: z.number(),
	candidate: stagedFieldsSchema,
	previous: previousFieldsSchema,
});
export type InflightConfigMarker = z.infer<typeof inflightMarkerSchema>;

export type StagingDeps = {
	readonly markerPath: string;
	readonly readMarker: (path: string) => string | undefined;
	readonly writeMarker: (path: string, contents: string) => void;
	readonly removeMarker: (path: string) => void;
};

export const defaultStagingDeps: StagingDeps = {
	markerPath: INFLIGHT_MARKER_FILE,
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
};

let staged: InflightConfigMarker | undefined;

export function getStagedConfigChange(): InflightConfigMarker | undefined {
	return staged;
}

/**
 * Hold an apply-now candidate WITHOUT persisting it. `config.json` keeps the
 * values that are still running on the engine, so a `reverted` costs no disk
 * write at all and a crash mid-transaction cannot leave the device booting into
 * a config the hardware never accepted.
 *
 * The stage belongs to ONE attempt at a time. While another attempt holds it,
 * this returns `false` and touches neither the held candidate nor the marker,
 * so an overlapping change can never replace, or later retire, the one in
 * flight.
 */
export function stageConfigChange(
	marker: InflightConfigMarker,
	deps: StagingDeps = defaultStagingDeps,
): boolean {
	if (staged !== undefined) return false;
	staged = marker;
	try {
		deps.writeMarker(deps.markerPath, JSON.stringify(marker));
	} catch (err) {
		// The in-memory stage is what this transaction runs on; the marker only
		// buys crash recovery, so failing to write it must not fail the change.
		logger.warn("could not write the config-change in-flight marker", { err });
	}
	return true;
}

/**
 * Free the in-memory stage but leave the marker on disk. With no change
 * owning it any more, reconciliation judges that marker like a crash leftover.
 */
export function releaseStagedConfigChange(): void {
	staged = undefined;
}

export function clearStagedConfigChange(
	deps: StagingDeps = defaultStagingDeps,
): void {
	staged = undefined;
	deps.removeMarker(deps.markerPath);
}

export function readInflightMarker(
	deps: StagingDeps = defaultStagingDeps,
): InflightConfigMarker | undefined {
	const raw = deps.readMarker(deps.markerPath);
	if (raw === undefined) return undefined;
	try {
		return inflightMarkerSchema.parse(JSON.parse(raw));
	} catch (err) {
		logger.warn("discarding an unreadable config-change in-flight marker", {
			err,
		});
		deps.removeMarker(deps.markerPath);
		return undefined;
	}
}

export type EngineEncodeSnapshot = {
	readonly streaming: boolean;
	readonly switching?: boolean;
	readonly resolution?: string;
	readonly framerate?: number;
	readonly codec?: string;
	readonly activeInput?: string;
	readonly pipelinePlaying?: boolean;
	readonly framesEmitted?: number;
};

export type ReconciliationVerdict =
	| { readonly action: "persist_candidate" }
	| { readonly action: "retain_previous" }
	| { readonly action: "wait" };

const matches = (
	candidate: string | number | undefined,
	actual: string | number | undefined,
): boolean => candidate === undefined || candidate === actual;

/**
 * The two axes where the marker and the engine can be RIGHT and still not be
 * `===`. `config.json` holds ladder rungs (`"2160p"`, `30`); the engine reports
 * pixels (`"3840x2160"`) and exact rates (`29.97` from `30000/1001`) — the same
 * vocabulary gap that made every apply-now resolution change fail on the dispatch
 * side (config-change-bridge.ts, "THE ENGINE SPEAKS PIXELS"). Here it would have
 * been quieter and worse: a false mismatch reads as "neither params set", i.e. an
 * eternal `wait` that never retires the marker.
 *
 * Both sides are folded onto the rung ladder, so `"4k"` vs `"3840x2160"` and
 * `30` vs `30.0` compare equal while a genuine difference still does not. Literal
 * equality is honoured first, so a value the ladder cannot place (an engine token
 * this build does not know) still matches itself and never silently widens.
 */
const resolutionMatches = (
	candidate: string | undefined,
	actual: string | undefined,
): boolean => {
	if (matches(candidate, actual)) return true;
	if (candidate === undefined || actual === undefined) return false;
	const rung = normalizeResolutionToRung(candidate);
	return rung !== undefined && rung === normalizeResolutionToRung(actual);
};

const framerateMatches = (
	candidate: number | undefined,
	actual: number | undefined,
): boolean => {
	if (matches(candidate, actual)) return true;
	if (candidate === undefined || actual === undefined) return false;
	const rung = normalizeFramerateToRung(candidate);
	return rung !== undefined && rung === normalizeFramerateToRung(actual);
};

function paramsMatch(
	fields: PreviousConfigFields,
	engine: EngineEncodeSnapshot,
): boolean {
	return (
		(fields.composition === undefined ||
			(fields.composition === null && engine.switching === true)) &&
		resolutionMatches(fields.resolution, engine.resolution) &&
		framerateMatches(fields.framerate, engine.framerate) &&
		matches(fields.video_codec, engine.codec) &&
		matches(fields.selected_video_input, engine.activeInput)
	);
}

/**
 * Whether a candidate's geometry is CONCRETE. A `null` is a local clear, and no
 * running-engine snapshot can prove it: an ingest publisher may report exactly
 * the geometry the previous source ran, so neither match distinguishes the two
 * sources. Only a stopped engine is authoritative about what it retained.
 */
function hasConcreteGeometry(
	fields: StagedConfigFields,
): fields is PreviousConfigFields {
	return fields.resolution !== null && fields.framerate !== null;
}

/**
 * Decide what a marker found at boot means. PURE — the caller owns the writes.
 *
 * Three outcomes, and the third one is the whole point: a transitional or
 * unreadable engine answer writes NOTHING and leaves the marker in place to be
 * re-evaluated on the next reconnect. Guessing in either direction persists a
 * config the operator never got or discards one they did.
 */
export function judgeInflightMarker(
	marker: InflightConfigMarker,
	engine: EngineEncodeSnapshot | undefined,
): ReconciliationVerdict {
	if (engine === undefined) return { action: "wait" };
	if (!engine.streaming) return { action: "retain_previous" };

	const gateSatisfied =
		engine.pipelinePlaying !== false && (engine.framesEmitted ?? 0) > 0;
	if (!gateSatisfied) return { action: "wait" };

	// A clear-carrying candidate is undecidable from ANY running snapshot. It
	// must stay undecided before both the candidate and previous branches, or a
	// previous-geometry match would retire evidence that cannot prove the switch
	// failed. A stopped engine was already answered above.
	const candidate = marker.candidate;
	if (!hasConcreteGeometry(candidate)) return { action: "wait" };

	const onCandidate = paramsMatch(candidate, engine);
	if (onCandidate) return { action: "persist_candidate" };

	const onPrevious = paramsMatch(marker.previous, engine);

	return onPrevious ? { action: "retain_previous" } : { action: "wait" };
}
