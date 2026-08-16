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
 * Unified `sources` builder (Wave 1, Todo 2).
 *
 * ONE operator-facing list of "what am I streaming", folding three inputs into a
 * single StreamSource[] the frontend renders directly:
 *   1. the engine capability contract's `sources[]` (the coarse offering — the
 *      SAME iteration the pipeline registry does today, `pipelines.ts:173-208`);
 *   2. the ENGINE-DEVICE CACHE (concrete `list-devices` devices, retained across
 *      a transient engine outage — the info `capabilities.ts` currently discards);
 *   3. the network-ingest gateway snapshot (rtmp/srt availability + LAN url).
 *
 * Build order is **caps.sources-FIRST, devices as an OVERLAY** (oracle defect 2):
 * a coarse capability source is NEVER lost. Every `caps.sources[]` entry becomes a
 * base entry; a bridgeable engine device then REPLACES the coarse entry it bridges
 * to with one concrete `capture` entry per device (real display name — this is
 * what kills the USB-as-HDMI mislabel). A device whose kind has no pipeline bridge
 * (usb/other/network/audio or any unbridged kind) is dropped — the coarse entry
 * survives so the source is never silently removed.
 *
 * This module owns NO wire routing: `deriveEngineRouting` maps a chosen source id
 * back to `{pipeline, selected_video_input?}` for the start choke point, and the
 * coarse/virtual/network arms deliberately return `selected_video_input:undefined`
 * (config-clear semantics) so a coarse selection NEVER injects an input_id — the
 * engine's existing `getActiveInput()` fallback (`cerastream-backend.ts:680`) is
 * left to fill it, byte-for-byte as today. T3 wraps this helper.
 */

import type {
	GetCapabilitiesResult,
	ListDevicesResult,
} from "@ceralive/cerastream";
import { deviceKindToPipelineId, pipelineIdForInputMode } from "@ceraui/rpc";
import type {
	CaptureDevice,
	CaptureInputMode,
	DevicesMessage,
	Framerate,
	InputMode,
	NetworkIngest,
	PipelineAudioKind,
	RequiresGateway,
	Resolution,
	SourceDegraded,
	SourcesMessage,
	SourcesVisibility,
	StreamSource,
	StreamSourceBase,
} from "@ceraui/rpc/schemas";
import {
	framerateSchema,
	inputModeSchema,
	resolutionSchema,
} from "@ceraui/rpc/schemas";
import type { LastSeenDevice } from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { broadcastMsg } from "../../rpc/compat.ts";
import { getConfig, saveConfig } from "../config.ts";
import { getNetworkIngestInfo } from "../network/network-ingest.ts";
import { clearHdmiSignalErrorOnRecovery } from "../system/hdmi-signal-notification.ts";
import type { EngineAudioDevice } from "./audio-naming.ts";
import {
	defaultFetchEngineDevices,
	getLastCapabilities,
	groupDeviceCaps,
} from "./capabilities.ts";
import {
	type CaptureDegradedSnapshot,
	getSelectedCaptureDegraded,
} from "./capture-degraded.ts";
import { fromEngineDevice } from "./devices.ts";
import { releasesV4l2Node } from "./held-devices.ts";
import { applyOnboardVideoDisplayRule } from "./onboard-display-names.ts";
import { reconcilePersistedDeviceMode } from "./persisted-mode-clamp.ts";
import { getEffectiveHardware } from "./pipelines.ts";
import { getConfiguredEngine } from "./streaming-engine.ts";

/** One entry of the engine capability contract's `sources[]` array. */
type CapabilitySource = GetCapabilitiesResult["sources"][number];

/** Source ids that ingest over a local network gateway (mirrors pipelines.ts). */
const NETWORK_SOURCE_IDS: Record<string, RequiresGateway> = {
	rtmp: "rtmp",
	srt: "srt",
};

/** The single virtual source id (the test pattern). */
const VIRTUAL_SOURCE_ID = "test";

/**
 * The coarse capability sources that describe a USB CAPTURE PIPELINE rather than
 * a port an operator can point at.
 *
 * These rows are phantoms and always were: `usb_mjpeg` renders permanently as
 * "USB MJPEG · not connected" whether or not any camera is attached, because a
 * pipeline is not a device. Worse, one physical dual-format camera answers to
 * TWO of them, so the coarse layer alone could show a single Osmo Pocket 3 as
 * two selectable rows. The device-first model already publishes exactly one
 * concrete row per physical camera, with its formats carried as `inputModes`,
 * so the coarse row adds nothing an operator can act on.
 *
 * They are suppressed in EVERY state, not merely when a device bridges to them —
 * a permanent phantom is exactly what the locked one-row-per-camera decision
 * removes. The no-devices empty state is the picker's single generic message.
 *
 * `v4l_mjpeg` is the starkest case: NO device kind bridges to it at all, so it
 * can never be replaced by a concrete row and is a phantom by construction.
 *
 * HDMI, network ingest and the test pattern are deliberately NOT here: each
 * names a real, always-present port or capability of the board itself, so a
 * coarse row for it is truthful even with nothing plugged in.
 */
const SUPPRESSED_COARSE_PIPELINE_IDS: ReadonlySet<string> = new Set([
	"libuvch264",
	"usb_mjpeg",
	"v4l_mjpeg",
	"camlink",
]);

/**
 * CeraUI-side fallback that keeps the virtual test-pattern source audio-
 * `selectable` even on an OLD engine that does not yet advertise
 * `supports_audio` for it. The cerastream test pattern gained a real muted
 * `audiotestsrc` tone leg AND a truthful `supports_audio: true` capability in
 * `2026.7.1` (coherence-contract-pass C2 / todo 4), reachable through the
 * existing "Pipeline default" pseudo-source. A device on an OLDER engine still
 * reports `supports_audio: false` for `test`, so this override bridges the gap
 * until the fleet minimum engine advertises it.
 *
 * PRECEDENCE: the engine's own `supports_audio` wins when true (new engine); the
 * override only decides the OLD-engine branch. It is scoped to the SINGLE
 * test-pattern id — a coarse/other source without `supports_audio` stays `none`
 * (no blanket override).
 *
 * DELETE this constant (and the virtual-origin branch in `deriveAudioKind` that
 * reads it) once every fleet device runs an engine that advertises
 * `supports_audio` for the test source. Tracked as `TD-test-pattern-audio-override`
 * in `docs/TECHNICAL_DEBT.md`.
 */
const TEST_PATTERN_AUDIO_OVERRIDE: boolean = true;

/** The i18n reason surfaced when a network gateway is not running. */
const GATEWAY_INACTIVE_REASON = "live.education.reason.gatewayInactive";

/** The i18n reason surfaced when the operator disabled the protocol in Settings. */
const DISABLED_IN_SETTINGS_REASON = "live.education.reason.disabledInSettings";

/** The i18n reason surfaced when the engine does not offer a device's pipeline. */
const PIPELINE_NOT_OFFERED_REASON = "live.education.reason.pipelineNotOffered";

/** The `settings.sources.<id>` i18n key family PipelineHelper already resolves. */
function sourceLabelKey(id: string): string {
	return `settings.sources.${id}`;
}

/** Coerce the engine's free-form resolution to a legal `Resolution` rung (else drop). */
function toResolution(value: string): Resolution | undefined {
	const parsed = resolutionSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** Coerce the engine's free-form framerate to a legal `Framerate` rung (else drop). */
function toFramerate(value: number): Framerate | undefined {
	const parsed = framerateSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/**
 * Audio provenance for a source (mirrors pipelines.ts `deriveAudioKind`): rtmp/srt
 * carry muxed `embedded` audio, an audio-capable capture source is `selectable`,
 * everything else is `none`.
 */
function deriveAudioKind(
	id: string,
	supportsAudio: boolean,
): PipelineAudioKind {
	if (NETWORK_SOURCE_IDS[id] !== undefined) return "embedded";
	// Test-pattern precedence (coherence-contract-pass C2): the virtual test
	// source is audio-`selectable` when EITHER the new engine advertises
	// supports_audio for it (>= 2026.7.1) OR the CeraUI-side old-engine override
	// is active. The tone itself is pipeline-default audio, surfaced through the
	// existing "Pipeline default" pseudo-source — no new picker entry is added.
	if (id === VIRTUAL_SOURCE_ID) {
		return supportsAudio || TEST_PATTERN_AUDIO_OVERRIDE ? "selectable" : "none";
	}
	return supportsAudio ? "selectable" : "none";
}

/** The facets every origin shares, derived from one `caps.sources[]` entry. */
function baseFacets(cap: CapabilitySource): StreamSourceBase {
	const resolution = toResolution(cap.default_resolution);
	const framerate = toFramerate(cap.default_framerate);
	return {
		id: cap.id,
		pipelineId: cap.id,
		modes: [],
		supportsAudio: cap.supports_audio,
		supportsResolutionOverride: cap.supports_resolution_override,
		supportsFramerateOverride: cap.supports_framerate_override,
		...(resolution !== undefined ? { defaultResolution: resolution } : {}),
		...(framerate !== undefined ? { defaultFramerate: framerate } : {}),
		audioKind: deriveAudioKind(cap.id, cap.supports_audio),
		available: true,
	};
}

/**
 * Network-source availability from the network-ingest snapshot. FAIL-CLOSED and
 * VISIBLE (oracle defect 7): a null/absent slot or an inactive gateway → the
 * source is still emitted, just `available:false` with the gateway-inactive
 * reason, never dropped.
 */
function networkAvailability(
	kind: RequiresGateway,
	ingest: NetworkIngest,
): { available: boolean; url: string | null; unavailableReason?: string } {
	const slot = ingest[kind];
	// Operator intent wins over unit truth: a NEW-topology shared unit may still
	// report service_active for the sibling protocol, but a protocol the operator
	// disabled must render unavailable with the disabled-in-settings reason.
	const operatorDisabled = slot?.operator_disabled === true;
	const active = slot?.service_active === true && !operatorDisabled;
	const reason = operatorDisabled
		? DISABLED_IN_SETTINGS_REASON
		: active
			? undefined
			: GATEWAY_INACTIVE_REASON;
	return {
		available: active,
		url: slot?.url ?? null,
		...(reason !== undefined ? { unavailableReason: reason } : {}),
	};
}

/** Build the ONE base entry for a `caps.sources[]` id (classified by origin). */
function buildBaseEntry(
	cap: CapabilitySource,
	ingest: NetworkIngest,
	hideTestPattern: boolean,
): StreamSource {
	const base = baseFacets(cap);
	if (cap.id === VIRTUAL_SOURCE_ID) {
		// Config-only visibility (Todo 6): a hidden test pattern stays EMITTED but
		// marked unavailable with the same reason the operator-disabled network
		// rows carry — the frontend owns fail-visible rendering. Never dropped.
		return {
			...base,
			...(hideTestPattern
				? { available: false, unavailableReason: DISABLED_IN_SETTINGS_REASON }
				: {}),
			origin: "virtual",
			labelKey: sourceLabelKey(cap.id),
		};
	}
	const gatewayKind = NETWORK_SOURCE_IDS[cap.id];
	if (gatewayKind !== undefined) {
		const { available, url, unavailableReason } = networkAvailability(
			gatewayKind,
			ingest,
		);
		return {
			...base,
			available,
			...(unavailableReason !== undefined ? { unavailableReason } : {}),
			origin: "network",
			labelKey: sourceLabelKey(cap.id),
			requiresGateway: gatewayKind,
			url,
		};
	}
	return { ...base, origin: "coarse", labelKey: sourceLabelKey(cap.id) };
}

/** Everything a capture row needs beyond the device itself and its coarse slot. */
interface CaptureEntryContext {
	/** Pipeline ids the engine currently advertises as coarse capability sources. */
	offeredPipelineIds: ReadonlySet<string>;
	/** The operator's persisted `config.input_mode`, if any. */
	persistedInputMode: InputMode | undefined;
	/** The standing degraded-selected snapshot, if any. */
	degraded: CaptureDegradedSnapshot | undefined;
}

/**
 * Stamp the degraded snapshot onto the ONE row it is about.
 *
 * Matched by stable identity first: the snapshot is taken at stream start and a
 * libuvc camera renumbers on the very next release, so a node-path-only match
 * would lose the row it describes. The node path is the fallback for a device
 * the engine gives no stable identity for.
 */
function degradedFor(
	device: CaptureDevice,
	snapshot: CaptureDegradedSnapshot | undefined,
): { degraded: SourceDegraded } | undefined {
	if (snapshot === undefined) return undefined;
	const matchesIdentity =
		snapshot.stableId !== undefined &&
		snapshot.stableId !== "" &&
		snapshot.stableId === device.stable_id;
	if (!matchesIdentity && snapshot.sourceId !== device.input_id)
		return undefined;
	return { degraded: snapshot.state };
}

/**
 * The mode families this device exposes that the board can ACTUALLY open.
 *
 * A family is published only when its `pipeline_kind` bridges to a pipeline the
 * engine currently advertises as a coarse capability source — exactly the rule
 * `buildSources` already applies to a whole device. Without it a camera could
 * offer the operator an MJPEG mode on a board whose engine never offered
 * `usb_mjpeg`, and the pick would die at `pipeline_not_in_offered_set` after
 * they had already committed to it.
 *
 * Each family carries its OWN ladder, projected through the same `groupDeviceCaps`
 * the flat list uses, so the two can never disagree about a rung.
 */
function buildInputModes(
	device: CaptureDevice,
	offeredPipelineIds: ReadonlySet<string>,
): CaptureInputMode[] {
	const out: CaptureInputMode[] = [];
	for (const mode of device.modes ?? []) {
		const pipelineId = pipelineIdForInputMode(mode.pipeline_kind);
		if (pipelineId === undefined || !offeredPipelineIds.has(pipelineId))
			continue;
		out.push({
			inputMode: mode.pipeline_kind,
			mediaType: mode.media_type,
			pipelineId,
			modes: groupDeviceCaps(mode.caps),
		});
	}
	return out;
}

/**
 * The format this device's leg will be opened under.
 *
 * The operator's persisted pick wins only while this device still advertises it
 * — a mode that disappeared (a different camera, a firmware change) must not
 * keep governing. Otherwise the answer is the engine's own scalar `kind`, which
 * IS its highest-precedence mode, so an operator who never chose gets H.264 on a
 * dual-format camera exactly as they did before modes existed.
 */
function resolveSelectedInputMode(
	device: CaptureDevice,
	inputModes: readonly CaptureInputMode[],
	persisted: InputMode | undefined,
): InputMode | undefined {
	if (
		persisted !== undefined &&
		inputModes.some((mode) => mode.inputMode === persisted)
	) {
		return persisted;
	}
	const parsed = inputModeSchema.safeParse(device.kind);
	return parsed.success ? parsed.data : undefined;
}

/** Build one concrete `capture` entry, inheriting facets from its coarse entry. */
function buildCaptureEntry(
	device: CaptureDevice,
	pipelineId: string,
	coarse: StreamSource,
	context: CaptureEntryContext,
): StreamSource {
	const inputModes = buildInputModes(device, context.offeredPipelineIds);
	const selectedInputMode = resolveSelectedInputMode(
		device,
		inputModes,
		context.persistedInputMode,
	);
	return {
		id: device.input_id,
		pipelineId,
		modes: device.caps !== undefined ? groupDeviceCaps(device.caps) : [],
		...(inputModes.length > 0 ? { inputModes } : {}),
		...(selectedInputMode !== undefined ? { selectedInputMode } : {}),
		...(degradedFor(device, context.degraded) ?? {}),
		// Stamped by `fromEngineDevice` (the only seam that knows the engine
		// authored the row); anything else is honestly `unknown`.
		signal: device.signal ?? "unknown",
		supportsAudio: coarse.supportsAudio,
		supportsResolutionOverride: coarse.supportsResolutionOverride,
		supportsFramerateOverride: coarse.supportsFramerateOverride,
		...(coarse.defaultResolution !== undefined
			? { defaultResolution: coarse.defaultResolution }
			: {}),
		...(coarse.defaultFramerate !== undefined
			? { defaultFramerate: coarse.defaultFramerate }
			: {}),
		audioKind: coarse.audioKind,
		available: true,
		origin: "capture",
		kind: device.kind,
		displayName: device.display_name,
		devicePath: device.device_path,
		...(device.stable_id !== undefined && device.stable_id !== ""
			? { stableId: device.stable_id }
			: {}),
		...(device.physical_group_id !== undefined &&
		device.physical_group_id !== ""
			? { physicalGroupId: device.physical_group_id }
			: {}),
	};
}

/**
 * Build one `lost` capture row from a remembered snapshot (C7): a device we saw
 * this session, or the configured device across a restart, that is absent from
 * the current engine list. It inherits facets from its still-offered coarse entry
 * and is always `available:false` + `lost:true` — the frontend renders the
 * unplugged grace state (`live.source.lostBody`) and a start/setConfig is refused
 * by the todo-12 gate.
 */
/**
 * A capture row for a live device whose pipeline this engine does not offer.
 *
 * The device→coarse fold intersects two INDEPENDENTLY-VERSIONED vocabularies —
 * the engine's `capabilities.sources[]` ids and CeraUI's
 * `DEVICE_KIND_TO_PIPELINE_ID` bridge — so when they disagree EVERY camera
 * disappears at once. Board-confirmed on a Rock 5B+: an engine advertising the
 * retired `camlink`/`v4l_mjpeg` ids produced an empty intersection, and a
 * connected 1080p59.94 HDMI-RX input and a connected USB camera both vanished
 * with nothing to distinguish it from "no hardware attached".
 *
 * Rendering it `available: false` with a reason is the same FAIL-CLOSED-AND-VISIBLE
 * rule `networkAvailability` applies to an inactive gateway. It stays
 * non-selectable because the pipeline really is not offered — a start would fail
 * at `pipeline_not_in_offered_set`.
 *
 * Scoped to kinds that DO name a video pipeline: `audio`/`network` and the SoC
 * codec/scaler nodes still drop, as they are not capture inputs. Facets are
 * conservative because the capability entry that would supply them is precisely
 * what is missing.
 */
function buildUnofferedCaptureEntry(
	device: CaptureDevice,
	pipelineId: string,
): StreamSource {
	return {
		id: device.input_id,
		pipelineId,
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: false,
		unavailableReason: PIPELINE_NOT_OFFERED_REASON,
		signal: device.signal ?? "unknown",
		origin: "capture",
		kind: device.kind,
		displayName: device.display_name,
		devicePath: device.device_path,
		...(device.stable_id !== undefined && device.stable_id !== ""
			? { stableId: device.stable_id }
			: {}),
		...(device.physical_group_id !== undefined &&
		device.physical_group_id !== ""
			? { physicalGroupId: device.physical_group_id }
			: {}),
	};
}

function buildLostEntry(
	snapshot: LastSeenDevice,
	coarse: StreamSource,
): StreamSource {
	return {
		id: snapshot.id,
		pipelineId: snapshot.pipelineId,
		modes: [],
		supportsAudio: coarse.supportsAudio,
		supportsResolutionOverride: coarse.supportsResolutionOverride,
		supportsFramerateOverride: coarse.supportsFramerateOverride,
		...(coarse.defaultResolution !== undefined
			? { defaultResolution: coarse.defaultResolution }
			: {}),
		...(coarse.defaultFramerate !== undefined
			? { defaultFramerate: coarse.defaultFramerate }
			: {}),
		audioKind: coarse.audioKind,
		available: false,
		lost: true,
		origin: "capture",
		kind: snapshot.kind,
		// A snapshot persisted before the onboard rule existed still holds the raw
		// driver id, so the rule is re-applied on read, not just on capture.
		displayName: applyOnboardVideoDisplayRule(snapshot.displayName),
		devicePath: snapshot.devicePath,
	};
}

export interface BuildSourcesInput {
	/** The engine capability contract's `sources[]` (the coarse offering). */
	sources: readonly CapabilitySource[];
	/** Concrete engine devices from the cache (video + audio; audio is ignored). */
	devices: readonly CaptureDevice[];
	/** The network-ingest gateway snapshot (rtmp/srt availability + LAN url). */
	networkIngest: NetworkIngest;
	/** Device-wide source visibility (Todo 6). Absent → every source visible. */
	sourcesVisibility?: SourcesVisibility;
	/** Persisted `config.last_streamed_source`: the device of the last
	 *  configuration that went live, and the ONLY one remembered while absent.
	 *  Absent → no lost row at all. */
	lastStreamedSource?: string;
	/** Persisted `config.last_streamed_source_stable_id`: the identity that slot
	 *  was anchored to. Absent → the slot resolves by node path. */
	lastStreamedStableId?: string;
	/** Persisted `config.last_seen_devices`; the metadata the remembered slot is
	 *  rendered from. Absent → treated as empty. */
	lastSeenDevices?: readonly LastSeenDevice[];
	/** The operator's persisted `config.input_mode`. Absent → engine precedence. */
	inputMode?: InputMode;
	/** The standing degraded-selected snapshot. Absent → no row is degraded. */
	degraded?: CaptureDegradedSnapshot;
}

/**
 * The identity two snapshots describe the SAME PHYSICAL DEVICE under: the
 * engine's `stableId` when it gave one, else the node-path id.
 *
 * A libuvc-driven camera renumbers its `/dev/videoN` node on every open/close
 * cycle (see `held-devices.ts`), so keying a remembered device on its id alone
 * treats each renumber as a NEW device. Live proof from a board's own
 * `config.json`: THREE `last_seen_devices` entries — `/dev/video1`,
 * `/dev/video2`, `/dev/video3` — all carrying the identical
 * `stableId: "usb:2ca3:0023:…"`, i.e. one camera rendered as three rows.
 *
 * Nothing here reads a vendor, product, serial, or display name: a device the
 * engine gives a stable identity for is folded by that identity, and one it does
 * not still keys on its node path exactly as before.
 */
function identityKey(device: LastSeenDevice): string {
	return device.stableId !== undefined && device.stableId !== ""
		? `stable:${device.stableId}`
		: `id:${device.id}`;
}

/**
 * Resolve `id` against remembered devices, preferring whoever CURRENTLY holds
 * the node path over anyone who merely retired it. `/dev/videoN` is reused
 * across replugs, so several devices can legitimately remember the same path —
 * a retired alias is only trustworthy when nobody holds the path outright.
 */
function findRememberingId(
	devices: readonly LastSeenDevice[],
	id: string,
): LastSeenDevice | undefined {
	return (
		devices.find((d) => d.id === id) ??
		devices.find((d) => d.previousIds?.includes(id) === true)
	);
}

function remembersNodePath(device: LastSeenDevice, id: string): boolean {
	return device.id === id || device.previousIds?.includes(id) === true;
}

/**
 * The ONE stable hardware identity a node path names, or `undefined` when the
 * path cannot be pinned to a single physical device.
 *
 * `/dev/videoN` is recycled, so several remembered devices can legitimately
 * answer to the same path — one holding it outright, another remembering it as a
 * retired alias. `findRememberingId` breaks that tie by PREFERENCE (holder wins),
 * which is the right rule for rendering a lost row and the wrong one for deciding
 * what hardware an operator's saved selection means: the board's own
 * `last_seen_devices` carried the HDMI-RX and a DJI Osmo Pocket 3 both answering
 * to `/dev/video3`, and the preference silently handed the Osmo's selection to
 * the HDMI-RX. A migration that re-points a selection at a different camera is
 * strictly worse than one that does not fire, so ambiguity refuses.
 *
 * Duplicate SNAPSHOTS of one device are not ambiguity — they fold to a single
 * identity key, so a `config.json` predating the identity fold still migrates
 * (and still self-heals on the next observation).
 */
function unambiguousStableId(
	devices: readonly LastSeenDevice[],
	id: string,
): string | undefined {
	const claimants = devices.filter((d) => remembersNodePath(d, id));
	const identities = new Set(claimants.map(identityKey));
	if (identities.size !== 1) return undefined;
	const stableId = claimants[0]?.stableId;
	return stableId === undefined || stableId === "" ? undefined : stableId;
}

/**
 * How many retired node paths one remembered device carries. A libuvc camera
 * renumbers on every open/close cycle, so this is unbounded churn without a cap;
 * 8 comfortably covers the window in which a stale `config.source` can still be
 * in play, and the list is most-recent-first so the cap drops the oldest.
 */
const RETIRED_ID_MEMORY = 8;

/**
 * Fold a superseded snapshot into the one that keeps the row: the survivor's
 * current identity wins, and the retired node path is remembered so a consumer
 * still holding it (a persisted `config.source`, the engine's `active_input`)
 * can still resolve this device instead of failing closed.
 */
function foldIdentity(
	survivor: LastSeenDevice,
	superseded: LastSeenDevice,
): LastSeenDevice {
	const previousIds = [
		...new Set([
			superseded.id,
			...(superseded.previousIds ?? []),
			...(survivor.previousIds ?? []),
		]),
	]
		.filter((id) => id !== survivor.id)
		.slice(0, RETIRED_ID_MEMORY);
	return previousIds.length > 0 ? { ...survivor, previousIds } : survivor;
}

/**
 * The ONE remembered snapshot eligible to become a lost row: the device of the
 * LAST-STREAMED configuration, and nothing else.
 *
 * The retired rule remembered every device the process had ever ENUMERATED, so
 * an unplugged accessory the operator had never streamed from — a colleague's
 * webcam, a dongle moved to another machine — kept a permanent unavailable row,
 * uncapped, for the lifetime of the backend. Merely having been seen is not
 * evidence that anyone wants it back; going live with it is. So exactly one
 * device is held: the one an outcome-gated start last committed to, which is
 * also the only one whose absence is worth interrupting an operator about.
 *
 * IDENTITY OUTRANKS THE PATH, AND REPLACES IT. When the slot carries a stable
 * id, that is the only thing matched: `last_streamed_source` is a node path, the
 * kernel recycles those, and `findRememberingId` deliberately resolves a
 * contested path by PREFERENCE (holder beats alias) — which is the right rule
 * for rendering a row and the wrong one for deciding which camera an operator
 * streamed. Falling back to the path there would remember whichever device had
 * since inherited it, the same mistake `resolveSourceIdentityDetailed` refuses
 * to make at the routing seam. A slot with no identity (a coarse, virtual or
 * network source, or an engine that vouches for none) resolves by path exactly
 * as the configured-device row always did.
 */
function collectLostCandidates(input: BuildSourcesInput): LastSeenDevice[] {
	const anchorId = input.lastStreamedSource;
	if (anchorId === undefined) return [];
	const remembered = input.lastSeenDevices ?? [];
	const anchorStableId = input.lastStreamedStableId;
	const anchored =
		anchorStableId !== undefined && anchorStableId !== ""
			? remembered.find((d) => d.stableId === anchorStableId)
			: findRememberingId(remembered, anchorId);
	return anchored === undefined ? [] : [anchored];
}

/**
 * Fold caps.sources + the engine-device cache + the network-ingest snapshot into
 * ONE StreamSource[]. Caps-first: every capability source is a base entry; a
 * bridgeable engine device then REPLACES the coarse entry it bridges to.
 */
export function buildSources(input: BuildSourcesInput): StreamSource[] {
	const hideTestPattern = input.sourcesVisibility?.hide_test_pattern ?? false;
	// (a) BASE — one entry per capability source, in contract order.
	const base = input.sources.map((cap) =>
		buildBaseEntry(cap, input.networkIngest, hideTestPattern),
	);

	// (b) OVERLAY — group bridgeable VIDEO devices by their target pipeline id. A
	// device only bridges when its kind maps to a pipeline id AND that id names a
	// COARSE base entry (usb/other/network/audio and unbridged kinds get NO
	// per-device entry; test bridges to the virtual entry, not a coarse one, so it
	// is left untouched — the test pattern stays exactly once).
	const coarseByPipeline = new Map<string, StreamSource>();
	for (const entry of base) {
		if (entry.origin === "coarse")
			coarseByPipeline.set(entry.pipelineId, entry);
	}
	// Built from the COARSE set, before any suppression: a suppressed placeholder
	// still proves the engine offers that pipeline, which is exactly the question
	// a mode family has to answer to be publishable.
	const captureContext: CaptureEntryContext = {
		offeredPipelineIds: new Set(coarseByPipeline.keys()),
		persistedInputMode: input.inputMode,
		degraded: input.degraded,
	};

	const capturesByPipeline = new Map<string, StreamSource[]>();
	const basePipelineIds = new Set(base.map((entry) => entry.pipelineId));
	const unofferedCaptures: StreamSource[] = [];
	// Live capture rows indexed by stable identity, so a remembered id the loop
	// below decides has MIGRATED can be published as an alias on its successor.
	const capturesByStableId = new Map<string, StreamSource[]>();
	const liveVideoIds = new Set<string>();
	// Stable hardware identities of the currently-live video devices. A remembered
	// device absent from the live list by NODE PATH but present here by STABLE
	// IDENTITY has re-enumerated (video1→video2 on a USB reset / unbind-rebind);
	// its row migrates to the live successor instead of orphaning a `lost` row
	// (Todo 34). An engine that never emits `stable_id` contributes nothing here,
	// so the lost loop degrades to node-path identity.
	//
	// Recorded only AFTER the bridge check, because "the live successor already
	// owns the row" is the whole justification for dropping the remembered `lost`
	// row — and an unbridged device owns no row. Recording it earlier suppressed
	// the `lost` row for a successor that was never rendered, so the device
	// vanished entirely (live: a RØDE replugged mid-stream returned as
	// /dev/video2 and neither row survived). Keeping `lost` is the honest floor.
	const liveStableIds = new Set<string>();
	for (const device of input.devices) {
		if (device.media_class !== "video") continue;
		liveVideoIds.add(device.input_id);
		const bridged = deviceKindToPipelineId(device.kind);
		if (bridged === undefined) continue;
		const coarse = coarseByPipeline.get(bridged);
		if (coarse === undefined) {
			// Dropping an engine-classified capture device here is what made a real,
			// connected camera vanish with no operator-visible reason — but only when
			// NOTHING in the catalog speaks for its pipeline. A `test`-kind device
			// bridges to the VIRTUAL test-pattern row, which already represents it.
			if (!basePipelineIds.has(bridged)) {
				unofferedCaptures.push(buildUnofferedCaptureEntry(device, bridged));
			}
			continue;
		}
		const entry = buildCaptureEntry(device, bridged, coarse, captureContext);
		if (device.stable_id !== undefined && device.stable_id !== "") {
			liveStableIds.add(device.stable_id);
			const byIdentity = capturesByStableId.get(device.stable_id) ?? [];
			byIdentity.push(entry);
			capturesByStableId.set(device.stable_id, byIdentity);
		}
		const list = capturesByPipeline.get(bridged) ?? [];
		list.push(entry);
		capturesByPipeline.set(bridged, list);
	}

	// (b2) LOST — a `lost` capture row (C7) for a remembered device absent from
	// the current engine list whose pipeline is STILL offered (a snapshot whose
	// pipelineId dropped from the coarse set yields no row). Grouped by pipeline
	// alongside its live captures so (c) collapses a remembered input to EXACTLY
	// one row — never a coarse+lost duplicate, never a live+lost duplicate.
	const lostByPipeline = new Map<string, StreamSource[]>();
	for (const snapshot of collectLostCandidates(input)) {
		if (liveVideoIds.has(snapshot.id)) continue;
		// Same physical device under a new node path (re-enumeration): the live
		// successor already owns the row, so drop the stale `lost` candidate — this
		// is the migrate-don't-orphan fix (Todo 34). A true unplug (no successor)
		// has no matching live stable id, so its `lost` row is preserved.
		if (
			snapshot.stableId !== undefined &&
			snapshot.stableId !== "" &&
			liveStableIds.has(snapshot.stableId)
		) {
			// Publish the retired node id as an alias on the successor. Without it
			// the migration is invisible on the wire, and every consumer still
			// holding the old id (the engine's `active_input`, a persisted
			// `config.source`) resolves to nothing and reports a live device lost.
			for (const successor of capturesByStableId.get(snapshot.stableId) ?? []) {
				if (successor.origin !== "capture") continue;
				successor.previousIds = [...(successor.previousIds ?? []), snapshot.id];
			}
			continue;
		}
		const coarse = coarseByPipeline.get(snapshot.pipelineId);
		if (coarse === undefined) continue;
		const list = lostByPipeline.get(snapshot.pipelineId) ?? [];
		list.push(buildLostEntry(snapshot, coarse));
		lostByPipeline.set(snapshot.pipelineId, list);
	}

	// (c) MERGE — replace each bridged coarse entry (in place, preserving order)
	// with its capture + lost entries; every other base entry passes through
	// unchanged. A coarse slot with only lost rows still collapses to those rows.
	const out: StreamSource[] = [];
	for (const entry of base) {
		if (entry.origin === "coarse") {
			const captures = capturesByPipeline.get(entry.pipelineId) ?? [];
			const lost = lostByPipeline.get(entry.pipelineId) ?? [];
			if (captures.length > 0 || lost.length > 0) {
				out.push(...captures, ...lost);
				continue;
			}
			// The bridged-device case above already replaced this slot; what is left
			// is the placeholder, and for a USB capture pipeline that placeholder is
			// a phantom in every state (see SUPPRESSED_COARSE_PIPELINE_IDS).
			if (SUPPRESSED_COARSE_PIPELINE_IDS.has(entry.pipelineId)) continue;
		}
		out.push(entry);
	}
	// Appended last, and only ever ADDITIVE: these devices bridged to no offered
	// coarse slot, so they displaced nothing above and cannot reorder it.
	out.push(...unofferedCaptures);
	return out;
}

/** The engine routing a chosen source id resolves to at the start choke point. */
export interface EngineRouting {
	pipeline: string;
	/** `undefined` for every non-capture origin (config-clear semantics). */
	selected_video_input: string | undefined;
}

/**
 * Resolve a source id to `{pipeline, selected_video_input?}` for ALL FOUR origins.
 * capture → pipeline = its bridged pipeline id + selected_video_input = input_id;
 * coarse/virtual/network → pipeline = pipelineId + selected_video_input =
 * undefined (a coarse selection must NEVER inject an input_id — the engine's
 * getActiveInput() fallback fills it). Returns `undefined` for an unknown id so
 * T3's `resolveSourceRouting` can map it to `{ok:false, error:'unknown_source'}`.
 */
export function deriveEngineRouting(
	sourceId: string,
	sources: readonly StreamSource[],
	inputMode?: InputMode,
): EngineRouting | undefined {
	const source = sources.find((s) => s.id === sourceId);
	if (source === undefined) return undefined;
	if (source.origin === "capture") {
		// A dual-format camera does not reach the engine through ONE pipeline: the
		// same hardware is `libuvch264` in H.264 mode and `usb_mjpeg` in MJPEG mode.
		// The row's own `pipelineId` is bridged from the device's SCALAR kind, so a
		// selected mode has to re-answer the question — and only against a family
		// this device actually publishes, which `buildInputModes` has already proven
		// is offered. An unrecognised mode falls back and never redirects.
		const selected = inputMode ?? source.selectedInputMode;
		const family = source.inputModes?.find((m) => m.inputMode === selected);
		return {
			pipeline: family?.pipelineId ?? source.pipelineId,
			selected_video_input: source.id,
		};
	}
	return { pipeline: source.pipelineId, selected_video_input: undefined };
}

export const UNKNOWN_SOURCE_ERROR = "unknown_source";
// A remembered capture row (C7 `lost:true`) — the device was unplugged and is no
// longer in the current engine list. Refused at the dispatch choke point.
export const SOURCE_LOST_ERROR = "source_lost";
// A listed-but-unavailable NETWORK source (`available:false` without `lost`): an
// operator-disabled / gateway-down network row. This is the ONLY origin whose
// `available:false` is a genuine functional block — a capture row's only false
// path is `lost` (gated separately above), and a virtual row's only false path is
// the operator's `sources_visibility.hide_test_pattern` declutter preference,
// which hides it from the picker but must NOT block routing.
export const SOURCE_UNAVAILABLE_ERROR = "source_unavailable";
// The persisted node path is LIVE, but a DIFFERENT physical device now holds it
// and the anchored one is gone (W4A4-F5). Distinct from `source_lost`: the path
// resolves fine, it just no longer names the operator's camera — so the honest
// answer is a refusal, never the inheritor.
export const SOURCE_TAKEN_OVER_ERROR = "source_taken_over";

export type ResolveSourceRoutingResult =
	| { ok: true; pipeline: string; selected_video_input: string | undefined }
	| {
			ok: false;
			error:
				| typeof UNKNOWN_SOURCE_ERROR
				| typeof SOURCE_LOST_ERROR
				| typeof SOURCE_UNAVAILABLE_ERROR
				| typeof SOURCE_TAKEN_OVER_ERROR;
	  };

// Procedure-layer wrapper over deriveEngineRouting. Reads the CURRENT sources
// snapshot at dispatch time, so a re-listed (recovered) device passes; every
// rejection leaves disk unchanged (session.start swallows updateConfig errors, so
// it must be enforced here). The `lost` check MUST precede the `available` check —
// a lost row is ALSO available:false, and it needs the distinct `source_lost`
// code. The `available:false` block is SCOPED to `origin === "network"` — the only
// origin where `available:false` is a genuine functional gate (gateway-down /
// operator-disabled). A virtual test-pattern's only `available:false` path is the
// `sources_visibility.hide_test_pattern` declutter preference, which hides it from
// the picker but must STILL route (a hidden-but-selected source is not broken); a
// capture row's only false path is `lost`, handled above. Absent →
// `unknown_source` (semantics unchanged). Never mutates config.
// Self-heal a persisted `config.source` whose literal id went stale after a
// device re-enumerated under a new node path (video1→video2). When the id is no
// longer a live source, look it up in `last_seen_devices` to recover its stable
// hardware identity, then return the LIVE capture source sharing that identity —
// so the operator's chosen device keeps routing across a replug instead of
// failing closed. A direct id hit, a missing stable id, or no live successor all
// return the id unchanged (no over-matching: a genuinely different device is
// never silently adopted). Mirrors the audio `resolveAudioSelection` stable-id
// join, adapted to the id→stableId indirection video persists.
//
// The identity must be UNAMBIGUOUS, which is stricter than "remembered". Node
// paths are recycled, so a path several devices answer to identifies none of
// them, and resolving it by preference re-points the selection at whichever
// hardware the tie-break happened to reach — see `unambiguousStableId`.
export function resolveSourceIdentity(
	sourceId: string,
	sources: readonly StreamSource[],
	lastSeenDevices?: readonly LastSeenDevice[],
	anchorStableId?: string,
): string {
	return resolveSourceIdentityDetailed(
		sourceId,
		sources,
		lastSeenDevices,
		anchorStableId,
	).id;
}

/** The one live capture row carrying a given stable identity, if any. */
function findByStableId(
	sources: readonly StreamSource[],
	stableId: string,
): StreamSource | undefined {
	return sources.find((s) => s.origin === "capture" && s.stableId === stableId);
}

export interface SourceIdentityResolution {
	id: string;
	/**
	 * The persisted node path IS live, but the device holding it is not the one
	 * the operator anchored — and the anchored device is nowhere in the current
	 * enumeration. Routing `id` here would open a camera nobody chose.
	 */
	takenOver: boolean;
}

/**
 * The identity-aware form of {@link resolveSourceIdentity}, which additionally
 * reports the one outcome a bare id cannot express: the operator's node path was
 * TAKEN OVER by different hardware (W4A4-F5).
 *
 * The short-circuit this replaces asked only whether the persisted path was
 * still live, never WHICH device answered to it — so a crossed drop/replug of
 * two cameras silently re-pointed a saved selection at the wrong one, and the
 * preview looked perfectly healthy while doing it. `anchorStableId` is the
 * identity captured when the selection was WRITTEN, which is the only evidence
 * that survives the fold (afterwards several remembered devices legitimately
 * claim the same path, so `unambiguousStableId` refuses — correctly — to guess).
 *
 * Suppression is impossible without positive proof: an absent anchor, a
 * non-capture row, and a live row the engine gave no `stableId` for all resolve
 * exactly as they did before this parameter existed.
 */
export function resolveSourceIdentityDetailed(
	sourceId: string,
	sources: readonly StreamSource[],
	lastSeenDevices?: readonly LastSeenDevice[],
	anchorStableId?: string,
): SourceIdentityResolution {
	const live = sources.find((s) => s.id === sourceId);
	if (live !== undefined) {
		if (anchorStableId === undefined) return { id: sourceId, takenOver: false };
		const liveStableId = live.origin === "capture" ? live.stableId : undefined;
		if (liveStableId === undefined || liveStableId === anchorStableId) {
			return { id: sourceId, takenOver: false };
		}
		const anchored = findByStableId(sources, anchorStableId);
		if (anchored !== undefined) return { id: anchored.id, takenOver: false };
		return { id: sourceId, takenOver: true };
	}
	// The anchor is the operator's own word, so it outranks the retroactive
	// `last_seen_devices` inference — which is also the only thing that still
	// works once a recycled path has several remembered claimants.
	const stableId =
		anchorStableId ?? unambiguousStableId(lastSeenDevices ?? [], sourceId);
	if (stableId === undefined) return { id: sourceId, takenOver: false };
	const successor = findByStableId(sources, stableId);
	return { id: successor?.id ?? sourceId, takenOver: false };
}

export function resolveSourceRouting(
	sourceId: string,
	sources: readonly StreamSource[],
	lastSeenDevices?: readonly LastSeenDevice[],
	anchorStableId?: string,
	inputMode?: InputMode,
): ResolveSourceRoutingResult {
	const resolution = resolveSourceIdentityDetailed(
		sourceId,
		sources,
		lastSeenDevices,
		anchorStableId,
	);
	if (resolution.takenOver) {
		return { ok: false, error: SOURCE_TAKEN_OVER_ERROR };
	}
	const effectiveId = resolution.id;
	const source = sources.find((s) => s.id === effectiveId);
	if (source === undefined) {
		return { ok: false, error: UNKNOWN_SOURCE_ERROR };
	}
	if (source.lost === true) {
		return { ok: false, error: SOURCE_LOST_ERROR };
	}
	if (source.origin === "network" && source.available === false) {
		return { ok: false, error: SOURCE_UNAVAILABLE_ERROR };
	}
	const routing = deriveEngineRouting(effectiveId, sources, inputMode);
	if (routing === undefined) {
		return { ok: false, error: UNKNOWN_SOURCE_ERROR };
	}
	return {
		ok: true,
		pipeline: routing.pipeline,
		selected_video_input: routing.selected_video_input,
	};
}

// ─── Selection write token (F10a) ───────────────────────────────────────────
//
// A monotonic stamp on the operator's stated intent, so a cache-driven
// reconciliation can never overwrite a selection that is NEWER than the evidence
// it is reasoning from.
//
// The reconciler decides against the engine-device cache, and that cache is
// deliberately RETAINED across a failed `list-devices` — the right contract for
// a device LIST (a transient outage must not erase the world), and the wrong one
// for authorizing a config MUTATION. Confirmed on a board during a ~5 minute
// cerastream outage: the cache was minutes old, and it overwrote an operator
// `setConfig({source})` 7 ms after it landed. "Device is no longer live", drawn
// from a view known not to have been refreshed, is not a verdict.
//
// `sourceSelectionToken` advances on every OPERATOR write of `config.source`
// (never on the reconciler's own write — that would make the mechanism refuse
// itself forever). `engineViewSelectionToken` records the token that was current
// when the evidence behind the CURRENT view was REQUESTED — captured before the
// probe's round-trip, not after it, so a probe that was already in flight when
// the operator saved cannot authorize a migration either. The compare-and-set is
// therefore exact: equal means nothing the operator did is newer than what the
// engine was asked.
//
// A failing probe commits nothing, so the stamp simply stops advancing and the
// reconciler stands down until the engine answers again — which is the
// engine-freshness gate this defect needed, without a wall-clock bound to tune.
let sourceSelectionToken = 0;
let engineViewSelectionToken = 0;

/**
 * Record that the OPERATOR has just written `config.source`. Every call site
 * that persists a stated selection — `streaming.setConfig`, the `start` path's
 * `updateConfig`, and the durable live `switchInput` follow — must call this, or
 * the reconciler may still overrule that selection from a stale view.
 */
export function noteSourceSelectionWrite(
	sourceId?: string,
	sources?: readonly StreamSource[],
): void {
	sourceSelectionToken += 1;
	if (sourceId === undefined) return;
	// A selection with no stable identity writes `undefined`, which CLEARS the
	// previous device's anchor — leaving it would let a retired camera govern the
	// resolution of a pick it has nothing to do with.
	getConfig().source_stable_id = resolveSelectionAnchor(
		sourceId,
		sources ?? getSourcesMessage().sources,
	);
}

/**
 * The stable hardware identity to persist beside a stated selection, or
 * `undefined` when the pick names no single physical device (a coarse, virtual
 * or network row, or a capture row the engine cannot vouch for).
 */
export function resolveSelectionAnchor(
	sourceId: string,
	sources: readonly StreamSource[],
): string | undefined {
	const source = sources.find((s) => s.id === sourceId);
	if (source === undefined || source.origin !== "capture") return undefined;
	const stableId = source.stableId;
	return stableId === undefined || stableId === "" ? undefined : stableId;
}

/**
 * The anchor governing `sourceId`, or `undefined` when it is not the PERSISTED
 * selection. A freshly stated pick carries no anchor yet — the operator is
 * choosing from the list in front of them, so the row they tapped is what they
 * mean, whatever it was called before.
 */
export function configuredSelectionAnchor(
	sourceId: string,
): string | undefined {
	const config = getConfig();
	if (config.source !== sourceId) return undefined;
	return config.source_stable_id;
}

/**
 * Move the remembered-lost slot onto the source a start has just PROVEN it can
 * deliver from, superseding whatever was remembered before.
 *
 * The commit signal is deliberately the engine's outcome gate — a session the
 * orchestrator has confirmed is really streaming — and NOT the pipeline reaching
 * PLAYING, which happens earlier and says only that a graph was built. A slot
 * moved on PLAYING would be moved by attempts that then fail, which is the one
 * thing the "a failed start changes nothing" rule forbids.
 *
 * A start that lands on the SAME source writes nothing at all. That is what
 * keeps an automatic restoration of an interrupted session from disturbing the
 * slot: a restoration re-commits the configuration that was already live, so
 * there is nothing to move and no config write to make.
 *
 * A source that names no single piece of hardware — coarse, virtual, network —
 * still takes the slot, and takes it EMPTY: `resolveSelectionAnchor` gives it no
 * identity, so nothing resolves to a remembered snapshot and the previously-held
 * camera simply stops being remembered. Superseding and clearing are the same
 * operation here, which is why there is no separate clear path.
 */
export function noteStreamedSourceCommitted(): boolean {
	const config = getConfig();
	const configured = config.source;
	if (configured === undefined) return false;

	const sources = getSourcesMessage().sources;
	// The same resolution the start path routed with, for the same reason: the
	// persisted id can be a node path the device has since left behind, and the
	// slot must name the hardware that actually went live.
	const sourceId = resolveSourceIdentity(
		configured,
		sources,
		config.last_seen_devices,
		configuredSelectionAnchor(configured),
	);
	const stableId = resolveSelectionAnchor(sourceId, sources);
	if (
		config.last_streamed_source === sourceId &&
		config.last_streamed_source_stable_id === stableId
	) {
		return false;
	}

	config.last_streamed_source = sourceId;
	if (stableId === undefined) {
		delete config.last_streamed_source_stable_id;
	} else {
		config.last_streamed_source_stable_id = stableId;
	}
	saveConfig();
	logger.info("sources: last-streamed source committed", {
		source: sourceId,
		stableId,
	});
	broadcastSourcesIfChanged();
	return true;
}

/** Test seam: the current operator-write / committed-view token pair. */
export function getSourceSelectionTokens(): {
	selection: number;
	engineView: number;
} {
	return {
		selection: sourceSelectionToken,
		engineView: engineViewSelectionToken,
	};
}

// ─── Engine-device cache ────────────────────────────────────────────────────
//
// The last-known concrete `list-devices` result, retained across a transient
// engine outage (a throwing/absent fetch keeps the prior list — it is NEVER
// discarded, and the cache is NOT refetched on every heartbeat tick). This is the
// device source `buildSources` overlays; the v4l2 registry fallback is
// deliberately NOT consulted here (its engine-down scan would re-introduce the
// kind-heuristic mislabel this whole model removes).

let engineDeviceCache: CaptureDevice[] = [];

// The parallel AUDIO cache (T4). The video cache above overlays into
// `buildSources`; audio devices are DELIBERATELY excluded from that video list,
// so their `list-devices` entries would otherwise be discarded. This cache
// RETAINS them (with the `alsa_card_id` join key) for the audio-naming join in
// `audio.ts`. It uses the dedicated `EngineAudioDevice` type — NEVER the
// `@ceraui/rpc` `CaptureDevice`, `fromEngineDevice()`, or the video whitelist
// copy — because those all drop the join key. `buildSources` never reads it.
let engineAudioDeviceCache: EngineAudioDevice[] = [];

// The last ENGINE-AUTHORED row for every video device this process has probed,
// keyed by `input_id`. Monotonic like `sessionSeenDeviceSnapshots` — a device
// leaving the list must NOT erase what the engine told us about it, because the
// case this exists for is precisely a device that left and came back.
//
// The local v4l2 scan reads a truthful card NAME but can only GUESS a kind from
// it (`deriveKind`), and for a UVC dongle that guess is `usb`, which bridges to
// no pipeline at all — so a row the scan alone vouches for silently disappears
// from `buildSources` and its coarse slot renders "not connected" instead. This
// map is what turns that guess back into the engine's own answer.
const lastEngineVideoDevices = new Map<string, CaptureDevice>();

/** The persisted last-seen list cap (C7). The current `config.source` id is
 *  exempt from eviction, so the configured device's snapshot survives churn. */
const LAST_SEEN_DEVICES_CAP = 12;

// The IN-MEMORY session-seen snapshot map: every bridgeable video input_id ever
// returned by a successful `list-devices` this process lifetime, keyed to its
// snapshot. UNCAPPED and monotonic — an empty list never clears it (distinct from
// the replaceable engineDeviceCache), and only `resetEngineDeviceCache()` drops it
// (test isolation).
//
// It is NO LONGER a lost-row candidate source. Under last-streamed-config
// retention a device that was merely SEEN is not remembered when it goes absent,
// so feeding this map to `collectLostCandidates` is precisely the uncapped
// behaviour that policy retires. What survives is its original job: the process's
// own record of what it has observed, which is what proves a renumbering camera
// folded onto ONE identity instead of accumulating a row per node path.
const sessionSeenDeviceSnapshots = new Map<string, LastSeenDevice>();

/** A bridgeable-video snapshot for a device, or `undefined` for a non-candidate
 *  (audio, or a kind with no pipeline bridge — never a lost-row candidate). */
function snapshotFromDevice(device: CaptureDevice): LastSeenDevice | undefined {
	if (device.media_class !== "video") return undefined;
	const pipelineId = deviceKindToPipelineId(device.kind);
	if (pipelineId === undefined) return undefined;
	return {
		id: device.input_id,
		displayName: device.display_name,
		kind: device.kind,
		pipelineId,
		devicePath: device.device_path,
		...(device.stable_id !== undefined ? { stableId: device.stable_id } : {}),
	};
}

/**
 * Collapse a snapshot list to ONE entry per physical device, freshest-first-wins.
 *
 * Applied to the observed and persisted halves TOGETHER, which gives the merge
 * below two properties at once: a device that came back on a new node path
 * updates its existing entry's `id`/`devicePath` IN PLACE instead of appending a
 * second row, and a list that ALREADY carries duplicates — persisted by a build
 * that predates this rule — self-heals on the next observation rather than
 * needing a hand-edited `config.json`.
 */
function dedupeByIdentity(
	devices: readonly LastSeenDevice[],
): LastSeenDevice[] {
	const byIdentity = new Map<string, LastSeenDevice>();
	for (const device of devices) {
		const key = identityKey(device);
		const kept = byIdentity.get(key);
		byIdentity.set(
			key,
			kept === undefined ? device : foldIdentity(kept, device),
		);
	}
	return [...byIdentity.values()];
}

/**
 * Give every node path exactly ONE owner, freshest-first-wins.
 *
 * Identity folding deliberately keeps two physically different devices as two
 * rows — but each may have occupied `/dev/videoN` at different times, and both
 * then go on claiming it as their current `id`. Every consumer resolving a
 * persisted `config.source` takes the first row answering to that id, so the
 * operator's selected camera can silently become whichever device was seen
 * most recently.
 *
 * The first claimant (the freshest, since observations lead the merge) keeps
 * the path; a later one demotes it to a retired alias so it stays resolvable
 * once nobody holds it outright. A row with no stable identity has no other
 * name to fall back on, so it is dropped rather than left ambiguous.
 */
function claimNodePathsOnce(
	devices: readonly LastSeenDevice[],
): LastSeenDevice[] {
	const claimed = new Set<string>();
	const kept: LastSeenDevice[] = [];
	for (const device of devices) {
		if (!claimed.has(device.id)) {
			claimed.add(device.id);
			kept.push(device);
			continue;
		}
		if (device.stableId === undefined || device.stableId === "") continue;
		claimed.add(device.stableId);
		kept.push({
			...device,
			id: device.stableId,
			previousIds: [
				...new Set([device.id, ...(device.previousIds ?? [])]),
			].slice(0, RETIRED_ID_MEMORY),
		});
	}
	return kept;
}

/**
 * LRU-merge freshly-observed snapshots into the persisted last-seen list:
 * most-recently-observed first, then prior entries whose device was not
 * re-observed. Over the cap, evict least-recent from the tail — EXCEPT the
 * entries named in `retained`, which are kept at their own position however
 * stale they are.
 *
 * TWO ids are retained, not one, and the second is load-bearing. The operator's
 * current selection has always been exempt; the LAST-STREAMED device now is too,
 * because its snapshot IS the lost row. The two are the same id most of the
 * time and deliberately come apart on a save-only edit — so without the second
 * exemption a dozen devices of churn could evict the very snapshot the retention
 * slot still points at, and the remembered device would go quietly missing from
 * the list instead of showing as absent. The CAP itself is untouched.
 */
function mergeLastSeenLru(
	current: readonly LastSeenDevice[],
	observed: readonly LastSeenDevice[],
	retained: ReadonlySet<string>,
): LastSeenDevice[] {
	const ordered = claimNodePathsOnce(
		dedupeByIdentity([...observed, ...current]),
	);
	if (ordered.length <= LAST_SEEN_DEVICES_CAP) return ordered;

	const kept = new Set<number>();
	ordered.forEach((device, index) => {
		if (retained.has(device.id)) kept.add(index);
	});
	for (
		let index = 0;
		index < ordered.length && kept.size < LAST_SEEN_DEVICES_CAP;
		index++
	) {
		kept.add(index);
	}
	return ordered.filter((_, index) => kept.has(index));
}

// Record a successful device observation into BOTH the uncapped session map and
// the persisted (capped, config.source-exempt) last-seen list. Only bridgeable
// video devices are snapshotted; an empty/no-bridgeable observation writes nothing
// (retention is preserved — an empty engine list must not drop remembered rows).
// The persisted list is written via the atomic config path only when it changes.
function recordObservedDevices(devices: readonly CaptureDevice[]): void {
	const snapshots: LastSeenDevice[] = [];
	for (const device of devices) {
		const snapshot = snapshotFromDevice(device);
		if (snapshot === undefined) continue;
		sessionSeenDeviceSnapshots.set(snapshot.id, snapshot);
		snapshots.push(snapshot);
	}
	if (snapshots.length === 0) return;

	const config = getConfig();
	const current = config.last_seen_devices ?? [];
	const retained = new Set(
		[config.source, config.last_streamed_source].filter(
			(id): id is string => id !== undefined,
		),
	);
	const next = mergeLastSeenLru(current, snapshots, retained);
	if (JSON.stringify(current) === JSON.stringify(next)) return;
	config.last_seen_devices = next;
	saveConfig();
}

/** The in-memory record of every bridgeable video device observed this process
 *  lifetime. Exposed for wiring and tests; it renders no rows. */
export function getSessionSeenDeviceSnapshots(): ReadonlyMap<
	string,
	LastSeenDevice
> {
	return sessionSeenDeviceSnapshots;
}

/** Injected fetcher so the cache is exercisable without a real engine. */
export interface EngineDeviceCacheDeps {
	fetchEngineDevices: () => Promise<ListDevicesResult>;
}

const defaultEngineDeviceCacheDeps: EngineDeviceCacheDeps = {
	fetchEngineDevices: defaultFetchEngineDevices,
};

/** The last-known engine device list (synchronous read; may be empty). */
export function getEngineDeviceCache(): CaptureDevice[] {
	return engineDeviceCache;
}

/** The last-known engine `list-devices` AUDIO entries (synchronous; may be empty). */
export function getEngineAudioDevices(): EngineAudioDevice[] {
	return engineAudioDeviceCache;
}

/** One answered `list-devices` probe, mapped but NOT yet applied to the caches. */
interface EngineDeviceProbe {
	devices: CaptureDevice[];
	audio: EngineAudioDevice[];
	// The operator-write token as it stood when this probe was DISPATCHED, so a
	// round-trip that was already in flight when a selection was saved commits a
	// view that is correctly marked older than that selection.
	selectionToken: number;
}

/**
 * Run one `list-devices` probe and map its result, WITHOUT touching the caches.
 * Separating the round-trip from the commit lets a caller decide — after the
 * await, with fresher knowledge than it had before — whether this answer still
 * deserves to become the current view (see `refreshSourcesForHotplug`).
 * `undefined` means the engine said nothing at all.
 */
async function probeEngineDevices(
	deps: EngineDeviceCacheDeps,
): Promise<EngineDeviceProbe | undefined> {
	const selectionToken = sourceSelectionToken;
	try {
		const result = await deps.fetchEngineDevices();
		const devices = result.devices.map((d) => {
			// `modes[]` is read defensively, exactly like the audio join keys below:
			// this whitelist copy is the ONE seam a real engine payload crosses, and
			// an unlisted field is DROPPED silently. It was, which made todo 21's
			// per-format mode families reachable only from a hand-built fixture —
			// every dual-format camera published `selectedInputMode` with no
			// `inputModes` beside it, so the picker had nothing to offer and the
			// encoder ladder fell back to the device's unioned flat list.
			const extra = d as { modes?: readonly unknown[] };
			return fromEngineDevice({
				input_id: d.input_id,
				device_path: d.device_path,
				display_name: d.display_name,
				media_class: d.media_class,
				kind: d.kind,
				caps: d.caps,
				...(extra.modes !== undefined ? { modes: extra.modes } : {}),
				stable_id: d.stable_id,
				physical_group_id: d.physical_group_id,
			});
		});
		rememberEngineVideoDevices(devices);
		return {
			devices,
			selectionToken,
			// Parallel AUDIO cache (T4): an EXPLICIT field copy of the audio entries
			// that PRESERVES the `alsa_card_id` join key verbatim. It is read
			// defensively (the pre-T18 binding schema strips it → `undefined`; the
			// bumped schema retains it), and it is NOT routed through the video
			// whitelist copy above or `fromEngineDevice()`, both of which drop it.
			audio: result.devices
				.filter((d) => d.media_class === "audio")
				.map((d) => {
					const extra = d as {
						alsa_card_id?: string;
						product_name?: string;
						transport?: EngineAudioDevice["transport"];
						stable_id?: string;
						physical_group_id?: string;
					};
					return {
						input_id: d.input_id,
						display_name: d.display_name,
						...(extra.alsa_card_id !== undefined
							? { alsa_card_id: extra.alsa_card_id }
							: {}),
						...(extra.product_name !== undefined
							? { product_name: extra.product_name }
							: {}),
						...(extra.transport !== undefined
							? { transport: extra.transport }
							: {}),
						...(extra.stable_id !== undefined
							? { stable_id: extra.stable_id }
							: {}),
						...(extra.physical_group_id !== undefined
							? { physical_group_id: extra.physical_group_id }
							: {}),
					};
				}),
		};
	} catch (err) {
		logger.debug(
			"sources: engine device fetch failed; retaining last-known device cache",
			{ err },
		);
		return undefined;
	}
}

function rememberEngineVideoDevices(devices: readonly CaptureDevice[]): void {
	for (const device of devices) {
		if (device.media_class !== "video") continue;
		lastEngineVideoDevices.set(device.input_id, device);
	}
}

/**
 * Restore the last engine-authored IDENTITY for an observed video device the
 * current probe cannot speak for — the same rule as "a probe entry matching an
 * observed `input_id` wins outright", applied to a REMEMBERED probe entry when
 * there is no current one.
 *
 * GUARDED BY DISPLAY NAME, not by `input_id` alone: the kernel recycles node
 * paths, so `/dev/video1` after an unplug may be a different device entirely,
 * and inheriting an identity is worse than showing a coarse one. Both lists
 * derive the name from the SAME kernel string — verified on the bug hardware,
 * where `/sys/class/video4linux/video1/name` and the engine's `display_name` are
 * byte-identical — so an equal name is real evidence of the same device, and an
 * unequal one leaves the observation exactly as it was.
 *
 * IDENTITY ONLY — never the remembered `caps`/`signal`. What the scan cannot
 * supply is WHAT this device IS: `deriveKind()` calls a UVC dongle `usb`, which
 * bridges to no pipeline, so its row is dropped (#219). `kind`/`stable_id` are
 * properties of the hardware; `caps` and the `signal` projected from them are one
 * probe's reading of what the cable carried when it was asked. Re-asserting those
 * for a device the CURRENT probe did not mention republishes a past answer as a
 * present one — an input that loses its signal and drops out of `list-devices`
 * then claims `signal: 'present'` forever, because the payload never changes and
 * `broadcastSourcesIfChanged` correctly stays silent. Same provenance rule
 * `fromEngineDevice` states: a row the engine did not confirm THIS time carries no
 * caps because nothing probed it, which reads `unknown` — not a stale `present`.
 */
function withKnownEngineMetadata(
	observed: CaptureDevice,
	known: ReadonlyMap<string, CaptureDevice>,
): CaptureDevice {
	if (observed.media_class !== "video") return observed;
	const remembered = known.get(observed.input_id);
	if (remembered === undefined) return observed;
	if (remembered.display_name !== observed.display_name) return observed;
	return {
		...observed,
		kind: remembered.kind,
		...(remembered.stable_id !== undefined
			? { stable_id: remembered.stable_id }
			: {}),
	};
}

/**
 * Re-resolve the audio labels/identities and the "Auto" preview after the engine
 * audio list CHANGED. Lazily imported to break the `audio.ts → sources.ts` cycle
 * (the same shape `devices.ts` uses for `onDevicesChanged`); never rejects.
 */
type EngineAudioChangeHandler = () => void;

const defaultEngineAudioChangeHandler: EngineAudioChangeHandler = () => {
	void import("./audio.ts")
		.then(({ reresolveAudioForEngineChange }) =>
			reresolveAudioForEngineChange(),
		)
		.catch((err) =>
			logger.debug("sources: audio re-resolve after engine change failed", {
				err,
			}),
		);
};

let engineAudioChangeHandler: EngineAudioChangeHandler =
	defaultEngineAudioChangeHandler;

/** Test seam: swap the engine-audio-change handler (`undefined` restores). */
export function setEngineAudioChangeHandler(
	fn: EngineAudioChangeHandler | undefined,
): void {
	engineAudioChangeHandler = fn ?? defaultEngineAudioChangeHandler;
}

/**
 * Make a device list the current view, remembering every device it proves live.
 *
 * A CHANGED audio list also re-resolves the audio surface, and that is the whole
 * point rather than a nicety: `audio.ts` caches the resolved label/identity maps
 * and only ever rebuilds them inside `updateAudioDevices()`, which runs on the
 * udev SIGUSR2 hotplug and at boot. The engine's own audio enumeration catches up
 * on ITS schedule — seconds later, via this commit — and nothing re-ran the join.
 * Confirmed live on a Rock 5B+: a DJI Osmo Pocket 3 plugged in mid-session showed
 * no `transport` and no `stable_id` for its card for the rest of the session,
 * while the engine had been reporting both within seconds of the plug; one
 * SIGUSR2 filled them in instantly. Same latched-stale class as
 * `policy_route_missing` and the video signal recheck.
 *
 * Keyed on the SERIALIZED list, so the 5 s signal recheck's steady state costs one
 * string compare and re-broadcasts nothing.
 */
function commitEngineDevices(
	devices: readonly CaptureDevice[],
	audio?: readonly EngineAudioDevice[],
	viewSelectionToken: number = sourceSelectionToken,
): void {
	engineDeviceCache = [...devices];
	engineViewSelectionToken = viewSelectionToken;
	let audioChanged = false;
	if (audio !== undefined) {
		const next = JSON.stringify(audio);
		audioChanged = next !== JSON.stringify(engineAudioDeviceCache);
		engineAudioDeviceCache = [...audio];
	}
	recordObservedDevices(engineDeviceCache);
	// Deliberately on EVERY commit, not only a changed one: a transient
	// `timing is invalid` dmesg line raises the notification while the engine's
	// own view never varies, so a change-gated hook would never retract it.
	clearHdmiSignalErrorOnRecovery(engineDeviceCache);
	if (audioChanged) engineAudioChangeHandler();
}

/**
 * Refresh the engine-device cache from a fresh `list-devices` probe, reporting
 * whether the probe actually answered. A throwing fetch (engine unavailable)
 * RETAINS the prior cache — the last-known device list is never lost to a
 * transient outage — and returns `false`, so a caller holding its OWN truthful
 * observation can tell "the engine confirmed this" from "the engine said nothing
 * and you are looking at the previous answer".
 */
export async function tryRefreshEngineDeviceCache(
	deps: EngineDeviceCacheDeps = defaultEngineDeviceCacheDeps,
): Promise<boolean> {
	const probe = await probeEngineDevices(deps);
	if (probe === undefined) return false;
	commitEngineDevices(probe.devices, probe.audio, probe.selectionToken);
	return true;
}

/**
 * Refresh the engine-device cache from a fresh `list-devices` probe. A successful
 * fetch replaces the cache wholesale (an empty live list legitimately clears it —
 * that is a reachable engine reporting no devices, NOT an outage); a failing one
 * retains the prior cache.
 */
export async function refreshEngineDeviceCache(
	deps: EngineDeviceCacheDeps = defaultEngineDeviceCacheDeps,
): Promise<CaptureDevice[]> {
	await tryRefreshEngineDeviceCache(deps);
	return engineDeviceCache;
}

/** Drop the cached engine device lists (video + audio) AND the session-seen
 *  snapshot map for test isolation (restart simulation). */
export function resetEngineDeviceCache(): void {
	engineDeviceCache = [];
	engineAudioDeviceCache = [];
	sessionSeenDeviceSnapshots.clear();
	lastEngineVideoDevices.clear();
	lastBroadcastSources = undefined;
	sourceSelectionToken = 0;
	engineViewSelectionToken = 0;
}

/**
 * Apply an ALREADY-OBSERVED device list (e.g. the device registry's scan result)
 * into the engine-device cache and lost-retention memory WITHOUT a second
 * `list-devices` fetch. A re-fetch here could throw (engine mid-restart) or return
 * a stale list and drop the hotplug transition, so the observed list the registry
 * already paid for is the single source of truth for this rebuild. The parallel
 * audio-naming cache is left untouched (the registry's `CaptureDevice` audio rows
 * carry no `alsa_card_id` join key; `refreshEngineDeviceCache` owns that cache).
 */
export function applyObservedEngineDevices(
	devices: readonly CaptureDevice[],
): void {
	commitEngineDevices(devices);
}

/**
 * ONE combined hotplug transition (C7): apply the observed list (no second fetch)
 * then rebroadcast BOTH the `devices` snapshot and the folded `sources` snapshot
 * from that same list, so a device unplugged via the registry path surfaces its
 * `lost` row in one pass — even when a re-fetch would throw or return the stale
 * pre-removal list.
 */
export function applyObservedDevicesAndBroadcast(
	devices: readonly CaptureDevice[],
): void {
	applyObservedEngineDevices(devices);
	const devicesMessage: DevicesMessage = {
		engine: getConfiguredEngine(),
		devices: [...devices],
	};
	broadcastMsg("devices", devicesMessage);
	broadcastSources();
}

// ─── Broadcast wiring (rides the existing `sources` bus, no new endpoint) ─────

/** Build the `sources` broadcast payload from the live caches (synchronous). */
export function getSourcesMessage(): SourcesMessage {
	const caps = getLastCapabilities();
	const config = getConfig();
	const sourcesVisibility = config.sources_visibility;
	const degraded = getSelectedCaptureDegraded();
	const sources = buildSources({
		sources: caps?.sources ?? [],
		devices: getEngineDeviceCache(),
		networkIngest: getNetworkIngestInfo(),
		...(sourcesVisibility !== undefined ? { sourcesVisibility } : {}),
		...(config.last_streamed_source !== undefined
			? { lastStreamedSource: config.last_streamed_source }
			: {}),
		...(config.last_streamed_source_stable_id !== undefined
			? { lastStreamedStableId: config.last_streamed_source_stable_id }
			: {}),
		lastSeenDevices: config.last_seen_devices ?? [],
		...(config.input_mode !== undefined
			? { inputMode: config.input_mode }
			: {}),
		...(degraded !== undefined ? { degraded } : {}),
	});
	return {
		hardware: getEffectiveHardware(),
		sources,
		...(degraded !== undefined ? { degradedSelected: degraded.state } : {}),
	};
}

/**
 * Migrate a persisted `config.source` onto the live successor of a device that
 * re-enumerated under a new node path, and PERSIST the migration.
 *
 * `resolveSourceIdentity` (PR #197) already recovers the successor at the
 * routing choke point, but it never wrote the result back — so the stored id
 * stayed the dead node path forever and every consumer that matches
 * `config.source` LITERALLY against a row id kept failing. That is one defect
 * with four faces, all confirmed live after a mid-stream RØDE replug
 * (/dev/video1 → /dev/video2): the "source disconnected" alert never cleared,
 * the "Now streaming" labels fell back to the raw `/dev/video1`, the switch
 * card's capture-session gate stopped matching so it vanished, and the operator
 * was left with an alert telling them to switch and nothing to switch with.
 *
 * Only a STABLE-IDENTITY match migrates (never a name or a slot guess), so a
 * genuinely different device is never adopted, and a real unplug keeps its
 * `lost` row and is left untouched. Returns whether the config changed.
 *
 * And only an engine view at least as new as the operator's own last word may
 * decide it. This is an INFERENCE about hardware; a saved selection is a stated
 * intent, and an inference drawn from evidence the operator has already
 * superseded must lose (F10a — see "Selection write token"). The refusal is not
 * terminal: the next answered probe re-stamps the view, and a migration that is
 * still true then still fires.
 */
export function reconcileConfiguredSourceIdentity(
	sources: readonly StreamSource[],
): boolean {
	const config = getConfig();
	const configured = config.source;
	if (configured === undefined) return false;
	const successor = resolveSourceIdentity(
		configured,
		sources,
		config.last_seen_devices,
		config.source_stable_id,
	);
	if (successor === configured) return false;
	if (engineViewSelectionToken !== sourceSelectionToken) {
		logger.debug(
			"sources: declining to migrate the configured source — the engine view predates the operator's selection",
			{ configured, successor },
		);
		return false;
	}

	config.source = successor;
	if (config.selected_video_input === configured) {
		config.selected_video_input = successor;
	}
	saveConfig();
	broadcastMsg("config", getConfig());
	logger.info(
		"sources: configured source re-enumerated under a new node path — migrated by stable identity",
		{ from: configured, to: successor },
	);
	return true;
}

// The last payload `broadcastSources` put on the wire, so a periodic re-probe
// can honour the "on-change" cadence of the `sources` event instead of pushing
// an identical snapshot to every client on every tick.
let lastBroadcastSources: string | undefined;

/** Push the current `sources` snapshot to all authenticated clients. */
export function broadcastSources(): void {
	const message = getSourcesMessage();
	// `config.source` feeds `collectLostCandidates`, so a migration has to be
	// rebuilt rather than published from the pre-migration snapshot.
	if (reconcileConfiguredSourceIdentity(message.sources)) {
		const migrated = getSourcesMessage();
		clampPersistedModeAndEcho(migrated.sources);
		lastBroadcastSources = JSON.stringify(migrated);
		broadcastMsg("sources", migrated);
		return;
	}
	clampPersistedModeAndEcho(message.sources);
	lastBroadcastSources = JSON.stringify(message);
	broadcastMsg("sources", message);
}

/**
 * This is the FIRST moment the device's ladder is known — `loadConfig()` runs at
 * boot, long before `list-devices` answers — which is why the persisted-mode
 * reconciliation hangs off the sources build rather than off the config loader.
 * It leaves the `sources` payload untouched, so no rebuild is needed; only the
 * `config` echo has to follow the write.
 */
function clampPersistedModeAndEcho(sources: readonly StreamSource[]): void {
	if (reconcilePersistedDeviceMode(sources)) {
		broadcastMsg("config", getConfig());
	}
}

function broadcastSourcesIfChanged(): void {
	// This runs the reconciler for the same reason the tick exists at all: it is
	// the ONLY periodic re-poke, and the one transition the hotplug path can miss
	// is an anchored device RETURNING after its node was taken over. Measured on
	// a board (W4A4-F5, 2026-07-31): the hotplug refresh fired at 20:49:00.661
	// with only the inheritor present — correctly refusing to migrate — the
	// anchored camera re-enumerated seconds later, and no further device-SET
	// change ever fired, so `config.source` stayed pointed at the wrong camera
	// with the right one sitting in the very same list. Reconciling here bounds
	// that self-heal to one recheck interval instead of leaving it to chance.
	const built = getSourcesMessage();
	const message = reconcileConfiguredSourceIdentity(built.sources)
		? getSourcesMessage()
		: built;
	const serialized = JSON.stringify(message);
	if (serialized === lastBroadcastSources) return;
	lastBroadcastSources = serialized;
	broadcastMsg("sources", message);
}

/**
 * Refresh the engine-device cache then broadcast the folded `sources` snapshot.
 * Seeded once at boot and re-poked when the offered set changes (mock hardware
 * swap); it never runs per heartbeat tick.
 */
export async function refreshAndBroadcastSources(
	deps: EngineDeviceCacheDeps = defaultEngineDeviceCacheDeps,
): Promise<void> {
	await refreshEngineDeviceCache(deps);
	broadcastSources();
}

/**
 * Fold an answered probe into the observation that triggered the rebuild.
 *
 * MEMBERSHIP comes from `observed` — the scan that just detected the transition
 * is, for the video set, the only list here known to be current. METADATA comes
 * from `probed`: an engine entry matching an observed `input_id` wins outright,
 * so typed kinds, capabilities and stable ids survive (the local scan only ever
 * guesses a kind from the display name). A device the probe never mentions keeps
 * its observed row rather than disappearing, and a device the probe still lists
 * but the scan no longer sees is dropped.
 *
 * Staying PRESENT is not the same as staying ITSELF, though, and the scan's
 * guess is not a harmless approximation: `deriveKind` calls a UVC dongle `usb`,
 * which bridges to no pipeline, so `buildSources` drops the row and renders the
 * coarse slot as "not connected". A device the probe omits therefore falls back
 * to what the engine last said about it (`known`) before it falls back to the
 * scan's guess.
 *
 * The join key is `input_id` alone: `buildDeviceList()` keys the fallback scan
 * `/dev/<card>`, byte-identical to the engine's own path-preferred id (verified
 * on a real Rock 5B+), so the two lists share one id namespace.
 *
 * ONE kind of device is exempt from the membership rule, and the exemption is
 * what the rule's own premise requires. `observed` is authoritative because the
 * `/dev` scan is a truthful presence oracle — but for a libuvc-driven camera it
 * is not one at all: the engine opens it through usbfs, which unbinds
 * `uvcvideo`, so the node is ABSENT for exactly as long as the capture works
 * (`held-devices.ts`). Confirmed live: the engine's own `list-devices` retained
 * `/dev/video1` for a whole streaming session and a whole idle preview
 * (cerastream PR #84/#86), while CeraUI's scan could not see it — so the merge
 * dropped the row and the operator's Source list badged a camera `Lost` and
 * "Device disconnected" while its preview was on screen. A probe-listed device
 * whose KIND releases its v4l2 node is therefore kept on the engine's word.
 * Safe in the other direction too: a genuinely unplugged camera is in neither
 * the engine's v4l2 registry nor its held set, so it is absent from the probe
 * and still yields its `lost` row.
 *
 * NON-VIDEO entries follow the probe verbatim. The observed list's audio rows
 * live in CeraUI's own `audio:<id>` namespace, not the engine's, so they are not
 * comparable — and `buildSources` overlays video only.
 */
export function mergeObservedWithProbe(
	observed: readonly CaptureDevice[],
	probed: readonly CaptureDevice[],
	known: ReadonlyMap<string, CaptureDevice> = lastEngineVideoDevices,
): CaptureDevice[] {
	const observedVideoIds = new Set(
		observed.filter((d) => d.media_class === "video").map((d) => d.input_id),
	);
	const probedVideoIds = new Set(
		probed.filter((d) => d.media_class === "video").map((d) => d.input_id),
	);
	const confirmed = probed.filter(
		(d) =>
			d.media_class !== "video" ||
			observedVideoIds.has(d.input_id) ||
			releasesV4l2Node(d.kind),
	);
	const unprobed = observed
		.filter((d) => d.media_class === "video" && !probedVideoIds.has(d.input_id))
		.map((d) => withKnownEngineMetadata(d, known));
	return [...confirmed, ...unprobed];
}

// Monotonic, never reset: a superseded probe answering late must stay superseded
// even across a `resetEngineDeviceCache()`.
let hotplugRefreshGeneration = 0;

/**
 * Rebuild + broadcast `sources` for a hotplug transition the device registry
 * detected with its OWN scan.
 *
 * A fresh authoritative engine `list-devices` probe is still preferred — its
 * typed kinds beat the local scan's display-name heuristic — but it is a SECOND,
 * separately-fallible round-trip that answers about a moment of its own choosing.
 * Two ways it can be wrong, and neither may overrule the observation:
 *
 * 1. It FAILS, and the cache is deliberately RETAINED — rebroadcasting the device
 *    the operator just unplugged as still available. So a failing probe hands over
 *    to the observation the registry already paid for.
 * 2. It SUCCEEDS but answers stale — a just-replugged USB device the OS has not
 *    finished re-enumerating is simply absent from a truthful engine answer. So
 *    membership is taken from the observation and only metadata from the probe.
 *
 * And because each transition starts its own round-trip, an OLDER refresh can
 * answer after a NEWER one has already published: a generation fence drops any
 * result that is no longer the current view rather than reviving the world it
 * asked about.
 */
/**
 * The device set to REBUILD `sources` from.
 *
 * Normally the registry's own observation verbatim — that is what lets a removal
 * survive a failing probe. Under MOCK_SCENARIO the registry observes the dev
 * HOST, which is hardware the scenario says nothing about, so its transitions
 * would publish an empty capture list over the simulated devices and the picker
 * would sit coarse-only for the life of the process. The scenario's own hotplug
 * seam is `setMockDeviceAttached`, so the scenario list is the observation here.
 *
 * The REGISTRY is deliberately left reading the host (`defaultGetEngineDevices`):
 * its scan is also `switchInput`'s reachability gate, and a device the scenario
 * makes visible in the picker is still not switchable when no engine or v4l2 node
 * backs it. Picker-visibility and switch-reachability are allowed to diverge.
 */
async function observedForSourcesRebuild(
	observed: readonly CaptureDevice[],
): Promise<readonly CaptureDevice[]> {
	const { shouldUseMocks } = await import("../../mocks/mock-service.ts");
	if (!shouldUseMocks()) return observed;
	const { getMockEngineDevices } = await import(
		"../../mocks/providers/streaming.ts"
	);
	return getMockEngineDevices().devices.map((d) =>
		fromEngineDevice({
			input_id: d.input_id,
			device_path: d.device_path,
			display_name: d.display_name,
			media_class: d.media_class,
			kind: d.kind,
			caps: d.caps,
			modes: d.modes,
			stable_id: d.stable_id,
		}),
	);
}

export async function refreshSourcesForHotplug(
	hostObserved: readonly CaptureDevice[],
	deps: EngineDeviceCacheDeps = defaultEngineDeviceCacheDeps,
): Promise<void> {
	// The ticket is taken SYNCHRONOUSLY, before any await, so two transitions
	// still order by the moment they were RAISED (the fence's whole premise).
	const generation = ++hotplugRefreshGeneration;
	const observed = await observedForSourcesRebuild(hostObserved);
	const probe = await probeEngineDevices(deps);
	if (generation !== hotplugRefreshGeneration) return;
	if (probe === undefined) {
		applyObservedDevicesAndBroadcast(
			observed.map((d) => withKnownEngineMetadata(d, lastEngineVideoDevices)),
		);
		return;
	}
	commitEngineDevices(
		mergeObservedWithProbe(observed, probe.devices),
		probe.audio,
		probe.selectionToken,
	);
	broadcastSources();
}

let signalRecheckInFlight = false;

/**
 * Re-probe the engine for devices whose SIGNAL may have changed while their
 * identity did not.
 *
 * The engine re-runs `VIDIOC_QUERY_DV_TIMINGS` on EVERY `list-devices`, so an
 * HDMI receiver that reports no modes while its link retrains and the one real
 * mode once it locks is answered correctly on the very next call. But NOTHING
 * calls: `refreshSourcesForHotplug` fires only on a device-SET change, and while
 * idle CeraUI holds no engine connection, so the registry polls a local v4l2
 * scan whose output never varies. `fromEngineDevice` reads zero caps as
 * `signal: 'absent'`, so the retraining answer latches and the operator reads
 * "No signal" for a device that locked minutes ago. Nothing here knows what an
 * HDMI receiver is — any device whose engine-reported caps change is picked up
 * identically.
 *
 * Membership, metadata and the generation fence follow `refreshSourcesForHotplug`
 * verbatim, with TWO deliberate divergences.
 *
 * A probe that says nothing changes nothing. This tick carries no detected
 * transition to publish, so falling back to `observed` the way a hotplug tick
 * must would republish a coarse guess over the engine's last real answer for no
 * reason at all.
 *
 * And a tick that finds one already in flight yields instead of starting a
 * second. Unlike a hotplug refresh this one fires unconditionally on a fixed
 * interval, so it is the one caller that can supersede ITSELF: a probe slower
 * than the interval is fenced out by the very next tick, whose probe is fenced
 * out by the one after it, and the loop publishes nothing for as long as the
 * engine stays slow. An enumeration is exactly what gets slow when a receiver
 * loses its link (the kernel re-runs the DV-timings query against a retraining
 * PHY), so the direction this exists to report is the direction that starves it.
 * Yielding keeps a single probe in flight and guarantees its answer is published.
 */
export async function recheckSourceSignals(
	observed: readonly CaptureDevice[],
	deps: EngineDeviceCacheDeps = defaultEngineDeviceCacheDeps,
): Promise<void> {
	if (signalRecheckInFlight) return;
	signalRecheckInFlight = true;
	try {
		await runSignalRecheck(observed, deps);
	} finally {
		signalRecheckInFlight = false;
	}
}

async function runSignalRecheck(
	hostObserved: readonly CaptureDevice[],
	deps: EngineDeviceCacheDeps,
): Promise<void> {
	const generation = ++hotplugRefreshGeneration;
	const observed = await observedForSourcesRebuild(hostObserved);
	const probe = await probeEngineDevices(deps);
	if (generation !== hotplugRefreshGeneration) return;
	if (probe === undefined) return;
	commitEngineDevices(
		mergeObservedWithProbe(observed, probe.devices),
		probe.audio,
		probe.selectionToken,
	);
	broadcastSourcesIfChanged();
}
