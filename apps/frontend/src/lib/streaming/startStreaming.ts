/**
 * Start-stream config assembly + validation — SINGLE SOURCE OF TRUTH (Task 16).
 *
 * `LiveView` persists encoder/server settings via `rpc.streaming.setConfig`
 * (Task 14), so the SAVED backend `ConfigMessage` (the `getConfig` snapshot) is
 * the authoritative source for a stream start. The only NOT-yet-persisted draft
 * is the working audio override (the AudioDialog edits it in memory until the
 * next stream start folds it in).
 *
 * This module assembles the full `ConfigMessage` handed to
 * `SystemHelper.startStreaming` (→ `rpc.streaming.start`) and gates it on the
 * two fields a stream cannot start without:
 *   - a video source (`pipeline`)
 *   - a server target (`srtla_addr` OR `relay_server`)
 *
 * Pure (no runes, no RPC, no Svelte) so the view can call it and tests can
 * exercise assembly + validation without side effects.
 */
import type { ConfigMessage } from "@ceraui/rpc/schemas";

/**
 * Working audio override layered over the saved config until stream (re)start.
 * Mirrors the `AudioConfigValues` the AudioDialog writes back to LiveView.
 */
export type AudioOverride = {
	asrc?: string;
	acodec?: ConfigMessage["acodec"];
	delay?: number;
} | null;

/** Reason a start was refused — maps to an i18n error key in the view. */
export type StartConfigError = "missingPipeline" | "missingServer";

export type StartConfigResult =
	| { ok: true; config: ConfigMessage }
	| { ok: false; error: StartConfigError };

/**
 * True when the saved config has a usable server target — either a direct
 * SRTLA address or a selected relay server. Mirrors LiveView's `serverTarget`.
 */
export function hasServerTarget(config: ConfigMessage | undefined): boolean {
	return Boolean(config?.srtla_addr || config?.relay_server);
}

/**
 * Assemble the full `ConfigMessage` for `rpc.streaming.start` from the SAVED
 * backend config, folding in the not-yet-persisted audio override.
 *
 * Validation gates (refuse, never start on a half-config):
 *   - `pipeline` must be set  → `missingPipeline`
 *   - a server target must be set → `missingServer`
 *
 * Audio fields prefer the working override, falling back to the saved config —
 * matching LiveView's `effectiveAudio*` deriveds.
 */
export function buildStartConfig(
	config: ConfigMessage | undefined,
	audioOverride: AudioOverride,
): StartConfigResult {
	const pipeline = config?.pipeline;
	if (!pipeline) {
		return { ok: false, error: "missingPipeline" };
	}

	if (!hasServerTarget(config)) {
		return { ok: false, error: "missingServer" };
	}

	const asrc = audioOverride?.asrc ?? config.asrc;
	const acodec = audioOverride?.acodec ?? config.acodec;
	const delay = audioOverride?.delay ?? config.delay;

	const assembled: ConfigMessage = {
		...config,
		pipeline,
		...(asrc !== undefined ? { asrc } : {}),
		...(acodec !== undefined ? { acodec } : {}),
		...(delay !== undefined ? { delay } : {}),
	};

	return { ok: true, config: assembled };
}
