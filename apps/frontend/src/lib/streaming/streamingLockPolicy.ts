/**
 * Streaming-active field-lock policy — SINGLE SOURCE OF TRUTH (Task 20).
 *
 * While a stream is LIVE, most encoder/audio/server config fields are
 * "restart-required": changing them mid-stream would force the pipeline to
 * tear down and re-establish, dropping the broadcast. Those fields are LOCKED
 * (read-only, "Stop stream to change") until the operator stops the stream.
 *
 * Exactly ONE field is HOT-CHANGEABLE while live: the target bitrate
 * (`max_br`), which the engine applies on the fly via `rpc.streaming.setBitrate`
 * with no pipeline restart.
 *
 * This module is PURE (no runes, no RPC, no Svelte) so it can be imported by
 * dialogs, the Live view, and unit tests without side effects.
 */

/**
 * Config fields that REQUIRE a stream restart to change.
 *
 * Names match the canonical `ConfigMessage` / `StreamingConfigInput` shape in
 * `@ceraui/rpc/schemas` plus the UI-only pipeline override fields
 * (`resolution`, `framerate`) that map onto the selected pipeline.
 */
export const RESTART_REQUIRED_FIELDS = [
	// Encoder / video source
	"pipeline", // video source element (camlink, hdmi, libuvch264, ...)
	"resolution", // pipeline resolution override
	"framerate", // pipeline framerate override
	// Audio
	"asrc", // audio source
	"acodec", // audio codec
	"delay", // audio delay
	// Server / transport
	"relay_server",
	"relay_account",
	"srtla_addr", // server address
	"srtla_port", // server port
	"srt_latency", // SRT latency
	"srt_streamid",
] as const;

/**
 * Config fields that can be changed WITHOUT stopping the stream.
 * `max_br` is pushed live through `rpc.streaming.setBitrate`.
 */
export const HOT_CHANGEABLE_FIELDS = ["max_br"] as const;

export type RestartRequiredField = (typeof RESTART_REQUIRED_FIELDS)[number];
export type HotChangeableField = (typeof HOT_CHANGEABLE_FIELDS)[number];
export type LockableField = RestartRequiredField | HotChangeableField;

/**
 * Logical config sections, used to lock a whole dialog's restart-required
 * inputs at once while still allowing a section to expose hot fields.
 */
export type StreamSection = "encoder" | "audio" | "server";

const SECTION_FIELDS: Record<StreamSection, readonly string[]> = {
	encoder: ["pipeline", "resolution", "framerate", "max_br"],
	audio: ["asrc", "acodec", "delay"],
	server: [
		"relay_server",
		"relay_account",
		"srtla_addr",
		"srtla_port",
		"srt_latency",
		"srt_streamid",
	],
};

const restartRequiredSet: ReadonlySet<string> = new Set(
	RESTART_REQUIRED_FIELDS,
);
const hotChangeableSet: ReadonlySet<string> = new Set(HOT_CHANGEABLE_FIELDS);

/**
 * Is the given config field read-only right now?
 *
 * - Never locked when not streaming.
 * - Hot-changeable fields (e.g. `max_br`) are never locked.
 * - Restart-required fields are locked while streaming.
 * - Unknown fields default to UNLOCKED (fail-open for UI fields not in the
 *   policy, e.g. cosmetic toggles like `bitrate_overlay`).
 */
export function isFieldLocked(
	fieldName: string,
	isStreaming: boolean,
): boolean {
	if (!isStreaming) return false;
	if (hotChangeableSet.has(fieldName)) return false;
	return restartRequiredSet.has(fieldName);
}

/** Convenience inverse of {@link isFieldLocked}. */
export function isFieldEditable(
	fieldName: string,
	isStreaming: boolean,
): boolean {
	return !isFieldLocked(fieldName, isStreaming);
}

/** True if a field is applied live (no restart) — only meaningful while streaming. */
export function isFieldHotChangeable(fieldName: string): boolean {
	return hotChangeableSet.has(fieldName);
}

/**
 * Does this section contain ANY restart-required field that is currently
 * locked? Used to badge a dialog/section trigger with "Stop stream to change".
 * Returns false for unknown sections.
 */
export function isSectionLocked(
	section: StreamSection,
	isStreaming: boolean,
): boolean {
	if (!isStreaming) return false;
	const fields = SECTION_FIELDS[section];
	if (!fields) return false;
	return fields.some((f) => isFieldLocked(f, isStreaming));
}

/** All field names belonging to a section (for callers that map inputs). */
export function fieldsForSection(section: StreamSection): readonly string[] {
	return SECTION_FIELDS[section] ?? [];
}
