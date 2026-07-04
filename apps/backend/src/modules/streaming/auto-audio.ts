/*
    CeraUI - web UI for the CERALIVE project
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
 * "Auto" audio-source resolution (T5).
 *
 * `config.asrc === "Auto"` (the AUDIO_SOURCE_AUTO sentinel) opts a config into
 * following its video source: the concrete audio card is picked at START time
 * (and previewed while IDLE), never persisted. `config.json` keeps the literal
 * "Auto"; only the LAUNCH-ONLY shallow copy carries the resolved key.
 *
 * TWO identifier spaces, NEVER conflated (Oracle R1-3):
 *   - `asrcKey`  — the wire string the operator/probe/status use (e.g. "HDMI",
 *                  "USB audio"). `asrcProbe(asrcKey)` looks up by this, the UI
 *                  looks labels up by this, and `getAudioSrcId(asrcKey)` maps it
 *                  to the card id at engine-start time.
 *   - `cardId`   — the ALSA card id behind the key (e.g. "rockchiphdmiin",
 *                  "usbaudio"). Returned for the same-device USB join and the
 *                  future TD-live-audio-follow engine work; no current caller
 *                  consumes it outside this module's own rules.
 * The live `audioDevices` map is `{ asrcKey → cardId }` (see audio.ts
 * `addAudioCardById`), so this module joins the two spaces by looking a key up by
 * its card-id VALUE — it must never treat one space as the other.
 *
 * The resolved value is MODULE STATE with a two-function emitter API. `is_streaming`
 * flips true BEFORE `startStream()` runs (session.ts), so a naive `getIsStreaming()`
 * guard would block the required start-time update while no guard would let a live
 * hotplug re-enumeration rewrite the frozen live value:
 *   - `setResolvedAsrcFromStart` force-updates current regardless of the flag
 *     (the start-time site);
 *   - `refreshResolvedAsrcPreview` updates current ONLY while idle (the
 *     source-change / hotplug preview site).
 * `pending_audio_follow_asrc` is a separate slot owned exclusively by T7's live-
 * switch site (`setPendingAudioFollowAsrc`); this module only clears it on a start.
 */

import type { ResolvedAsrcReason, StreamSource } from "@ceraui/rpc/schemas";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { getConfig } from "../config.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { getAudioDevices } from "./audio.ts";
import type { EngineAudioDevice } from "./audio-naming.ts";
import { getLastCapabilities } from "./capabilities.ts";
import { getEngineAudioDevices, getSourcesMessage } from "./sources.ts";
import { getIsStreaming } from "./streaming.ts";

// ─── Resolver contract ───────────────────────────────────────────────────────

/** The ALSA card ids the deterministic rules key off (the resolver's contract). */
const HDMI_CARD_ID = "rockchiphdmiin";
const ANALOG_CARD_ID = "rockchipes8388";
const CAMLINK_CARD_ID = "C4K";
const USB_AUDIO_CARD_ID = "usbaudio";

/** The two pseudo-source asrcKeys — pipeline sentinels, not real ALSA cards. */
const PIPELINE_DEFAULT_ASRC = "Pipeline default";
const NO_AUDIO_ASRC = "No audio";
const PSEUDO_CARD_IDS = new Set<string>([NO_AUDIO_ASRC, PIPELINE_DEFAULT_ASRC]);

/** Video device kinds that share a chassis with a USB/UVC audio card. */
const USB_VIDEO_KINDS = new Set<string>([
	"usb",
	"uvc_h264",
	"uvc_h265",
	"mjpeg",
]);

/** Minimum shared display-name prefix for the same-device USB join (rule 5i). */
const MIN_COMMON_PREFIX = 4;

export interface AutoAsrcResolution {
	/** The wire string for `asrcProbe`/status/`getAudioSrcId`; null for embedded. */
	asrcKey: string | null;
	/** The ALSA card id behind `asrcKey`; null for embedded/pseudo sources. */
	cardId: string | null;
	/** Which rule fired — the status discriminator (Oracle R9-1). */
	reason: ResolvedAsrcReason;
}

export interface ResolveAutoAsrcInput {
	/** The currently-selected source (from `config.source`); may be undefined. */
	source: StreamSource | undefined;
	/** The live `{ asrcKey → cardId }` device map (audio.ts `getAudioDevices`). */
	audioDevices: Record<string, string>;
	/** The engine `list-devices` audio entries (the USB same-device join input). */
	engineAudio: readonly EngineAudioDevice[];
	/** Whether the engine routes muxed network-ingest audio (embedded path). */
	networkEmbeddedAudio: boolean | undefined;
}

/** Case-insensitive length of the shared leading prefix of two strings. */
function commonPrefixLength(a: string, b: string): number {
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	const limit = Math.min(x.length, y.length);
	let i = 0;
	while (i < limit && x[i] === y[i]) i++;
	return i;
}

/** The first asrcKey whose card-id VALUE equals `cardId` (dual-space join). */
function findAsrcKeyByCardId(
	audioDevices: Record<string, string>,
	cardId: string,
): string | undefined {
	for (const [asrcKey, value] of Object.entries(audioDevices)) {
		if (value === cardId) return asrcKey;
	}
	return undefined;
}

/** The first enumerated non-pseudo, non-HDMI, non-analog device card (rule 5iii). */
function firstDeviceEntry(
	audioDevices: Record<string, string>,
): { asrcKey: string; cardId: string } | undefined {
	for (const [asrcKey, cardId] of Object.entries(audioDevices)) {
		if (PSEUDO_CARD_IDS.has(cardId)) continue;
		if (cardId === HDMI_CARD_ID || cardId === ANALOG_CARD_ID) continue;
		return { asrcKey, cardId };
	}
	return undefined;
}

/** The rule-6 fallback: the pipeline-default pseudo source (no ALSA card). */
function pipelineDefault(): AutoAsrcResolution {
	return {
		asrcKey: PIPELINE_DEFAULT_ASRC,
		cardId: null,
		reason: "pipeline-default",
	};
}

/**
 * Resolve `config.asrc === "Auto"` to a concrete audio target via the SIX
 * deterministic rules, in order. PURE — no I/O, no module state, no side effects.
 *
 *   1. network origin + embedded cap → embedded (engine omits `audio.device`).
 *   2. network w/o cap, OR the virtual (test-pattern) source → pipeline default.
 *   3. HDMI capture → the `rockchiphdmiin` card, when it is enumerated.
 *   4. Cam Link capture → the `C4K` card, when it is enumerated.
 *   5. USB/UVC capture →
 *        (i)  an engine audio entry sharing a >=4-char name prefix with the video
 *             device AND whose `alsa_card_id` is enumerated here (same device);
 *        (ii) else the generic `usbaudio` card, when enumerated;
 *        (iii) else the first enumerated non-HDMI / non-analog device card.
 *   6. nothing matched → the pipeline-default pseudo source.
 */
export function resolveAutoAsrc(
	input: ResolveAutoAsrcInput,
): AutoAsrcResolution {
	const { source, audioDevices, engineAudio, networkEmbeddedAudio } = input;

	// Rule 1 — a network source whose muxed audio the engine can route itself.
	if (source?.origin === "network" && networkEmbeddedAudio === true) {
		return { asrcKey: null, cardId: null, reason: "embedded" };
	}

	// Rule 2 — a network source WITHOUT the embedded cap, or the test pattern:
	// use the pipeline's own default audio (a pseudo source, not an ALSA card).
	if (source?.origin === "network" || source?.origin === "virtual") {
		return pipelineDefault();
	}

	// Rules 3-5 apply only to a concrete capture device.
	if (source?.origin === "capture") {
		// Rule 3 — HDMI capture follows the HDMI audio card, when present.
		if (source.kind === "hdmi") {
			const asrcKey = findAsrcKeyByCardId(audioDevices, HDMI_CARD_ID);
			if (asrcKey !== undefined) {
				return { asrcKey, cardId: HDMI_CARD_ID, reason: "hdmi" };
			}
		}

		// Rule 4 — Cam Link capture follows the C4K audio card, when present.
		if (source.kind === "camlink") {
			const asrcKey = findAsrcKeyByCardId(audioDevices, CAMLINK_CARD_ID);
			if (asrcKey !== undefined) {
				return { asrcKey, cardId: CAMLINK_CARD_ID, reason: "camlink" };
			}
		}

		// Rule 5 — the USB/UVC camera family.
		if (USB_VIDEO_KINDS.has(source.kind)) {
			// (i) same-device join: an engine audio entry whose name shares a
			//     >=4-char prefix with the video device AND whose card is
			//     enumerated here. First in engine list order wins. Falls through
			//     gracefully when `alsa_card_id` is absent (pre-T18 pin).
			const cardValues = new Set(Object.values(audioDevices));
			for (const entry of engineAudio) {
				if (entry.alsa_card_id === undefined) continue;
				if (!cardValues.has(entry.alsa_card_id)) continue;
				if (
					commonPrefixLength(entry.display_name, source.displayName) >=
					MIN_COMMON_PREFIX
				) {
					const asrcKey = findAsrcKeyByCardId(audioDevices, entry.alsa_card_id);
					if (asrcKey !== undefined) {
						return {
							asrcKey,
							cardId: entry.alsa_card_id,
							reason: "usb-same-device",
						};
					}
				}
			}

			// (ii) the generic USB audio card alias, when enumerated.
			const usbAsrcKey = findAsrcKeyByCardId(audioDevices, USB_AUDIO_CARD_ID);
			if (usbAsrcKey !== undefined) {
				return {
					asrcKey: usbAsrcKey,
					cardId: USB_AUDIO_CARD_ID,
					reason: "usb-alias",
				};
			}

			// (iii) the first enumerated non-HDMI / non-analog device card.
			const first = firstDeviceEntry(audioDevices);
			if (first !== undefined) {
				return {
					asrcKey: first.asrcKey,
					cardId: first.cardId,
					reason: "first-device",
				};
			}
		}
	}

	// Rule 6 — nothing matched.
	return pipelineDefault();
}

/**
 * The launch-only `asrc` for a resolution: `undefined` for the embedded / pipeline-
 * default PSEUDO sources (the probe is skipped and `audio.device` is omitted so the
 * engine takes its own default/embedded path), else the resolved asrcKey. Applies
 * to the AUTO launch path only.
 */
export function launchAsrcFor(
	resolution: AutoAsrcResolution,
): string | undefined {
	if (resolution.reason === "embedded") return undefined;
	if (resolution.asrcKey === null) return undefined;
	if (resolution.asrcKey === PIPELINE_DEFAULT_ASRC) return undefined;
	return resolution.asrcKey;
}

/**
 * Build the LAUNCH-ONLY shallow config copy carrying the resolved key (or omitting
 * `asrc` for a pseudo source). NEVER mutates `config` — the persisted config keeps
 * the "Auto" sentinel by construction.
 */
export function buildAutoLaunchConfig(
	config: RuntimeConfig,
	resolution: AutoAsrcResolution,
): RuntimeConfig {
	const launchAsrc = launchAsrcFor(resolution);
	if (launchAsrc === undefined) {
		const { asrc: _drop, ...rest } = config;
		return rest;
	}
	return { ...config, asrc: launchAsrc };
}

/** Gather live state and resolve — the shared start-path / preview resolver. */
export function resolveAutoAsrcFromLiveState(): AutoAsrcResolution {
	const config = getConfig();
	const sources = getSourcesMessage().sources;
	const source =
		config.source !== undefined
			? sources.find((s) => s.id === config.source)
			: undefined;
	return resolveAutoAsrc({
		source,
		audioDevices: getAudioDevices(),
		engineAudio: getEngineAudioDevices(),
		networkEmbeddedAudio: getLastCapabilities()?.network_embedded_audio,
	});
}

// ─── Module state + two-function emitter API ─────────────────────────────────

let resolvedAsrc: string | null = null;
let resolvedAsrcReason: ResolvedAsrcReason | null = null;
let pendingAudioFollowAsrc: string | null = null;

/** The status update the emitters broadcast; the three T5 fields only. */
interface AutoAudioStatusUpdate {
	resolved_asrc?: string | null;
	resolved_asrc_reason?: ResolvedAsrcReason | null;
	pending_audio_follow_asrc?: string | null;
}

type AutoAudioBroadcaster = (update: AutoAudioStatusUpdate) => void;

const defaultBroadcaster: AutoAudioBroadcaster = (update) =>
	broadcastMsg("status", update);

let broadcaster: AutoAudioBroadcaster = defaultBroadcaster;

/** Test seam: swap the status broadcaster (idempotent restore with `undefined`). */
export function setAutoAudioBroadcaster(
	fn: AutoAudioBroadcaster | undefined,
): void {
	broadcaster = fn ?? defaultBroadcaster;
}

/** The CURRENTLY-APPLIED / idle-preview Auto resolution (null = none/old). */
export function getResolvedAsrc(): string | null {
	return resolvedAsrc;
}

/** The resolution's `reason` discriminator (null = none/old). */
export function getResolvedAsrcReason(): ResolvedAsrcReason | null {
	return resolvedAsrcReason;
}

/** The target a deferred live follow will apply at next start (null = none). */
export function getPendingAudioFollowAsrc(): string | null {
	return pendingAudioFollowAsrc;
}

/**
 * (A) The START-TIME emitter. Force-updates the current resolution (regardless of
 * the `is_streaming` flag — it has already flipped true by now), clears any pending
 * follow, and broadcasts all three fields together. Called ONLY from `startStream`.
 */
export function setResolvedAsrcFromStart(
	asrcKey: string | null,
	reason: ResolvedAsrcReason,
): void {
	resolvedAsrc = asrcKey;
	resolvedAsrcReason = reason;
	pendingAudioFollowAsrc = null;
	broadcaster({
		resolved_asrc: resolvedAsrc,
		resolved_asrc_reason: resolvedAsrcReason,
		pending_audio_follow_asrc: null,
	});
}

/**
 * (B) The PREVIEW emitter. Resolve-if-Auto → update current → broadcast, but ONLY
 * while NOT streaming (while streaming the current value stays frozen at the
 * start-time resolution — a live re-enumeration must never rewrite it). NEVER
 * touches `pending_audio_follow_asrc` (that is T7's live-switch site alone). Called
 * from `setConfig` after a source/asrc change and from `updateAudioDevices`.
 */
export function refreshResolvedAsrcPreview(): void {
	if (getIsStreaming()) return; // frozen live value — no current, no pending write
	if (getConfig().asrc !== AUDIO_SOURCE_AUTO) return; // resolve-if-Auto only
	const resolution = resolveAutoAsrcFromLiveState();
	resolvedAsrc = resolution.asrcKey;
	resolvedAsrcReason = resolution.reason;
	broadcaster({
		resolved_asrc: resolvedAsrc,
		resolved_asrc_reason: resolvedAsrcReason,
	});
}

/**
 * The PENDING emitter — the ONLY writer of `pending_audio_follow_asrc`. Used by
 * T7's deferred live-follow site (implemented here now since T5 owns the module)
 * and cleared to null on stream stop. Broadcasts only the pending field.
 */
export function setPendingAudioFollowAsrc(value: string | null): void {
	pendingAudioFollowAsrc = value;
	broadcaster({ pending_audio_follow_asrc: value });
}

/** Reset all module state — test isolation only. */
export function resetAutoAudioState(): void {
	resolvedAsrc = null;
	resolvedAsrcReason = null;
	pendingAudioFollowAsrc = null;
}
