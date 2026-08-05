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
import { getAudioCaptureCardIds, getAudioDevices } from "./audio.ts";
import type { EngineAudioDevice } from "./audio-naming.ts";
import { getLastCapabilities } from "./capabilities.ts";
import {
	resetCapturePresence,
	resolveSelectedSourceWithGrace,
} from "./capture-presence.ts";
import { getEngineAudioDevices, getSourcesMessage } from "./sources.ts";
import { getIsStreaming } from "./streaming.ts";

// ─── Resolver contract ───────────────────────────────────────────────────────

/**
 * The HDMI-RX capture card, in EVERY spelling the kernel gives it.
 *
 * Which spelling a board reports is decided by the KERNEL TRACK it runs, not by
 * the hardware. The Rockchip vendor 6.1 BSP registers the card as
 * `rockchiphdmiin`; the mainline / Armbian `edge` 7.1 tree drives the same
 * physical port through the Synopsys `snps_hdmirx` receiver and a first-party
 * `simple-audio-card` DT node, which names it `hdmirx`. Board-proven on a Rock
 * 5B+ running `7.1.5-ceralive-rk3588`: `/proc/asound/cards` reads
 * `2 [hdmirx] : simple-card - hdmirx`, `/proc/asound/pcm` gives it a real
 * `capture 1` substream, and a live capture through `hw:2,0` recorded genuinely
 * non-silent audio (mean volume −29.0 dB). With ONE spelling hardcoded, rule 3
 * looked `rockchiphdmiin` up, found nothing, and fell silently through — so
 * "Auto" NEVER bound HDMI audio on that kernel, for hardware that demonstrably
 * captures.
 *
 * This is the same one-block-many-names problem the VIDEO half already carries
 * (`ONBOARD_VIDEO_DISPLAY_RULES` lists `rkhdmirx` / `snpshdmirx` / …) and it has
 * the same answer: key on the IP BLOCK, never on a board model or kernel version.
 *
 * It stays a NAME LIST deliberately. cerastream's `capture_card_ids()` finds
 * capture-capable cards generically, with no names at all — but that answers
 * "can this card record", which CeraUI already asks separately via
 * `captureCapableCardIds` (see `provenIncapableOfCapture`). Rule 3's question is
 * "WHICH card is this port's audio half", and answering it by capability would
 * bind an HDMI source to whatever unrelated microphone happened to be plugged
 * in — precisely the cross-device guess rule 5 was rewritten to remove.
 *
 * ORDER IS THE CONTRACT: the first spelling this device ENUMERATES wins, so a
 * board reporting more than one resolves deterministically and a vendor-6.1
 * board behaves byte-identically to before this list existed.
 */
const HDMI_CARD_IDS: readonly string[] = ["rockchiphdmiin", "hdmirx"];

/** The ALSA card id rule 4 keys off (the resolver's contract). */
const CAMLINK_CARD_ID = "C4K";

/** The pipeline-default pseudo-source asrcKey — a sentinel, not a real ALSA card. */
const PIPELINE_DEFAULT_ASRC = "Pipeline default";

/**
 * The no-audio pseudo-source asrcKey (`audio.ts` `NO_AUDIO_ID`), spelled locally
 * for the same reason `PIPELINE_DEFAULT_ASRC` is: `audio.ts` imports this module,
 * so a top-level import of its const would evaluate in the cycle's TDZ.
 */
const NO_AUDIO_ASRC = "No audio";

/** Video device kinds that share a chassis with a USB/UVC audio card. */
const USB_VIDEO_KINDS = new Set<string>([
	"usb",
	"uvc_h264",
	"uvc_h265",
	"mjpeg",
]);

export interface AutoAsrcResolution {
	/** The wire string for `asrcProbe`/status/`getAudioSrcId`; null for embedded. */
	asrcKey: string | null;
	/** The ALSA card id behind `asrcKey`; null for embedded/pseudo sources. */
	cardId: string | null;
	/** Which rule fired — the status discriminator (Oracle R9-1). */
	reason: ResolvedAsrcReason;
	/**
	 * The same-physical-device asrcKeys behind an `ambiguous-same-device-audio`
	 * reason — the exact set the UI must offer for manual selection. Present ONLY
	 * on that reason; every other resolution omits it.
	 */
	candidates?: string[];
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
	/**
	 * The scanned cards owning at least one CAPTURE PCM (`audio.ts`
	 * `getAudioCaptureCardIds`). OPTIONAL and FAIL-OPEN: `undefined` means the
	 * capture-PCM question has not been asked, and an unasked question is never
	 * evidence — the rules bind exactly as they did before this gate existed.
	 */
	captureCapableCardIds?: ReadonlySet<string>;
}

/**
 * The TypeScript mirror of cerastream's `same_physical_group` (ADR-0008 §6).
 *
 * Two devices share a physical group IF AND ONLY IF both carry a group key and
 * the keys are equal. An ABSENT group NEVER matches — not another absent group,
 * not itself — because `None` means "this device has no USB topology to key on"
 * (HDMI-RX, onboard audio, Bluetooth, test sources), not "unknown, might be the
 * same". A bare `a === b` would silently pair every group-less card with every
 * group-less camera, which is precisely the cross-device guess this rule exists
 * to remove. An empty string is treated as absent: the wire carries the key as an
 * optional string, and `""` is no topology token.
 */
function samePhysicalGroup(
	a: string | undefined,
	b: string | undefined,
): boolean {
	if (a === undefined || a === "") return false;
	if (b === undefined || b === "") return false;
	return a === b;
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

/**
 * The first of `cardIds` this device ENUMERATES, paired with the asrcKey it is
 * known by — the multi-spelling form of {@link findAsrcKeyByCardId}. Returns
 * `undefined` when none of the spellings is enumerated, which is the unchanged
 * "fall through to the next rule" answer.
 */
function findEnumeratedCard(
	audioDevices: Record<string, string>,
	cardIds: readonly string[],
): { asrcKey: string; cardId: string } | undefined {
	for (const cardId of cardIds) {
		const asrcKey = findAsrcKeyByCardId(audioDevices, cardId);
		if (asrcKey !== undefined) return { asrcKey, cardId };
	}
	return undefined;
}

/**
 * Every ENUMERATED audio card belonging to the SAME physical device as the
 * camera, in engine-list order. A candidate must clear three gates: the engine
 * gave it an `alsa_card_id` (no join key, no candidate), it shares the camera's
 * physical group, and CeraUI itself enumerates that card (a card the engine sees
 * but this device cannot open is not selectable). Deduped by asrcKey — two engine
 * rows can resolve to one card.
 */
function sameDeviceAudioCandidates(
	cameraGroup: string | undefined,
	audioDevices: Record<string, string>,
	engineAudio: readonly EngineAudioDevice[],
): { asrcKey: string; cardId: string }[] {
	const found = new Map<string, { asrcKey: string; cardId: string }>();
	for (const entry of engineAudio) {
		if (entry.alsa_card_id === undefined) continue;
		if (!samePhysicalGroup(cameraGroup, entry.physical_group_id)) continue;
		const asrcKey = findAsrcKeyByCardId(audioDevices, entry.alsa_card_id);
		if (asrcKey === undefined) continue;
		if (found.has(asrcKey)) continue;
		found.set(asrcKey, { asrcKey, cardId: entry.alsa_card_id });
	}
	return [...found.values()];
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
 * LISTED IS NOT RECORDABLE — the rule-3/4 refusal (`W4A4-F1`).
 *
 * Rules 3 and 4 bind a card named by a FIXED id list on the strength of CeraUI's
 * own sysfs scan ENUMERATING it, and enumeration is not the same question as
 * "can this be recorded from". The RK3588 HDMI-RX proves the gap: card 3 lists
 * permanently, yet `/proc/asound/pcm` carries
 * `03-00: rockchip,hdmiin i2s-hifi-0 :` with NO `capture N` field and
 * `arecord -l` never shows it — measured on a Rock 5B+
 * with a LOCKED 1080p59.94 signal on the port, so this is not the no-cable case.
 * Binding it made EVERY `asrc: "Auto"` start on the HDMI source die with
 * `audio-device-unavailable … not_retriable`: an operator whose camera was
 * working could not go live at all.
 *
 * The honest answer is an explicit video-only stream, not a dead card and not a
 * silent omission — `NO_AUDIO_ASRC` resolves to the engine's `audio.mode: "none"`,
 * so the start SUCCEEDS, while `no-capture-audio` tells the UI exactly why there
 * is no audio. Omitting `asrc` instead would hand the engine its own legacy
 * inference over the very port that cannot deliver.
 *
 * The gate is asked about the spelling that MATCHED, never about a canonical
 * one: the HDMI-RX enumerates under a different card id per kernel track
 * (`HDMI_CARD_IDS`), and either spelling can list without a capture PCM — the
 * mainline `hdmirx` card is registered by a DT sound node that exists whether or
 * not a cable is locked, exactly like its vendor counterpart.
 *
 * Rule 5 deliberately does NOT need this gate: its candidates must each carry an
 * `alsa_card_id` from the ENGINE's `list-devices`, and a card with no capture PCM
 * never appears there at all — the engine has already answered the question.
 */
function noCaptureAudio(): AutoAsrcResolution {
	return {
		asrcKey: NO_AUDIO_ASRC,
		cardId: null,
		reason: "no-capture-audio",
	};
}

/** Has the scan PROVEN this card cannot capture? An unasked question has not. */
function provenIncapableOfCapture(
	cardId: string,
	captureCapableCardIds: ReadonlySet<string> | undefined,
): boolean {
	if (captureCapableCardIds === undefined) return false;
	return !captureCapableCardIds.has(cardId);
}

/**
 * Resolve `config.asrc === "Auto"` to a concrete audio target via the SIX
 * deterministic rules, in order. PURE — no I/O, no module state, no side effects.
 *
 *   1. network origin + embedded cap → embedded (engine omits `audio.device`).
 *   2. network w/o cap, OR the virtual (test-pattern) source → pipeline default.
 *   3. HDMI capture → the HDMI-RX audio card, when it is enumerated, under
 *      whichever of its kernel-track spellings this board reports.
 *   4. Cam Link capture → the `C4K` card, when it is enumerated.
 *   5. USB/UVC capture → the camera's OWN audio, identified by `physical_group_id`
 *      equality (cerastream ADR-0008), and NOTHING else:
 *        exactly one same-group card  → that card (`usb-same-device`);
 *        several same-group cards     → `ambiguous-same-device-audio`, NO pick;
 *        none, or a group-less camera → `no-same-device-audio`, NO pick.
 *   6. nothing matched → the pipeline-default pseudo source.
 *
 * Rule 5 NEVER names a card on a different physical device. The retired
 * longest-shared-display-name-prefix join did exactly that: a DJI Osmo Pocket 3
 * reports its audio as the ALSA longname `"DJI DJIPocket3 at usb-…"` against a
 * V4L2 video name of `"DJIPocket3: OsmoPocket3"`, which share only `"DJI"`, so
 * the join missed and "Auto" served a still-enumerated RØDE's microphone — a
 * DIFFERENT device's mic, presented as the camera's own. Name similarity is not
 * evidence of shared hardware; USB topology is. The two typed non-resolutions are
 * the honest answers, and the UI turns each into a manual-selection prompt.
 */
export function resolveAutoAsrc(
	input: ResolveAutoAsrcInput,
): AutoAsrcResolution {
	const {
		source,
		audioDevices,
		engineAudio,
		networkEmbeddedAudio,
		captureCapableCardIds,
	} = input;

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
		// Rule 3 — HDMI capture follows the HDMI audio card, when it can capture.
		// The capture gate is asked about the spelling that actually MATCHED, so a
		// listed-but-unrecordable card is refused under either kernel's name.
		if (source.kind === "hdmi") {
			const hdmi = findEnumeratedCard(audioDevices, HDMI_CARD_IDS);
			if (hdmi !== undefined) {
				if (provenIncapableOfCapture(hdmi.cardId, captureCapableCardIds)) {
					return noCaptureAudio();
				}
				return { asrcKey: hdmi.asrcKey, cardId: hdmi.cardId, reason: "hdmi" };
			}
		}

		// Rule 4 — Cam Link capture follows the C4K audio card, same gate.
		if (source.kind === "camlink") {
			const asrcKey = findAsrcKeyByCardId(audioDevices, CAMLINK_CARD_ID);
			if (asrcKey !== undefined) {
				if (provenIncapableOfCapture(CAMLINK_CARD_ID, captureCapableCardIds)) {
					return noCaptureAudio();
				}
				return { asrcKey, cardId: CAMLINK_CARD_ID, reason: "camlink" };
			}
		}

		// Rule 5 — the USB/UVC camera family: the camera's OWN audio, or nothing.
		if (USB_VIDEO_KINDS.has(source.kind)) {
			const candidates = sameDeviceAudioCandidates(
				source.physicalGroupId,
				audioDevices,
				engineAudio,
			);
			const only = candidates[0];
			if (candidates.length === 1 && only !== undefined) {
				return {
					asrcKey: only.asrcKey,
					cardId: only.cardId,
					reason: "usb-same-device",
				};
			}
			if (candidates.length > 1) {
				return {
					asrcKey: null,
					cardId: null,
					reason: "ambiguous-same-device-audio",
					candidates: candidates.map((c) => c.asrcKey),
				};
			}
			return {
				asrcKey: null,
				cardId: null,
				reason: "no-same-device-audio",
			};
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

/**
 * Gather live state and resolve — the shared start-path / preview resolver.
 *
 * The selected source is resolved through an ABSENCE GRACE WINDOW rather than a
 * plain `find`, because the device view this reads has a real, normal hole in it.
 * libuvc's reattach guard rebinds the camera's USB interfaces around every
 * open/close, and on RELEASE the engine drops its held record before the
 * successor node is rediscovered — for up to 2 s the camera's video row is
 * missing, or present but stripped of the `physical_group_id` rule 5 joins on.
 * Resolving that window literally reported a bound, streaming microphone as "no
 * audio device". Only the VERDICT is held; the device list, the `lost` row and
 * routing are untouched, and a sustained absence still resolves honestly.
 * Contract: `capture-presence.ts`.
 */
export function resolveAutoAsrcFromLiveState(): AutoAsrcResolution {
	const config = getConfig();
	const sources = getSourcesMessage().sources;
	const source = resolveSelectedSourceWithGrace(config.source, sources);
	return resolveAutoAsrc({
		source,
		audioDevices: getAudioDevices(),
		engineAudio: getEngineAudioDevices(),
		networkEmbeddedAudio: getLastCapabilities()?.network_embedded_audio,
		captureCapableCardIds: getAudioCaptureCardIds(),
	});
}

// ─── Module state + two-function emitter API ─────────────────────────────────

let resolvedAsrc: string | null = null;
let resolvedAsrcReason: ResolvedAsrcReason | null = null;
let resolvedAsrcCandidates: string[] | null = null;
let pendingAudioFollowAsrc: string | null = null;

/** The status update the emitters broadcast; the four resolution fields only. */
interface AutoAudioStatusUpdate {
	resolved_asrc?: string | null;
	resolved_asrc_reason?: ResolvedAsrcReason | null;
	resolved_asrc_candidates?: string[] | null;
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

/**
 * The same-physical-device audio candidates the operator must choose between
 * (null unless the reason is `ambiguous-same-device-audio`).
 */
export function getResolvedAsrcCandidates(): string[] | null {
	return resolvedAsrcCandidates;
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
	candidates?: readonly string[],
): void {
	resolvedAsrc = asrcKey;
	resolvedAsrcReason = reason;
	resolvedAsrcCandidates = candidates === undefined ? null : [...candidates];
	pendingAudioFollowAsrc = null;
	broadcaster({
		resolved_asrc: resolvedAsrc,
		resolved_asrc_reason: resolvedAsrcReason,
		resolved_asrc_candidates: resolvedAsrcCandidates,
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
	resolvedAsrcCandidates = resolution.candidates ?? null;
	broadcaster({
		resolved_asrc: resolvedAsrc,
		resolved_asrc_reason: resolvedAsrcReason,
		resolved_asrc_candidates: resolvedAsrcCandidates,
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
	resolvedAsrcCandidates = null;
	pendingAudioFollowAsrc = null;
	resetCapturePresence();
}
