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
import { deviceKindToPipelineId } from "@ceraui/rpc";
import type {
	CaptureDevice,
	Framerate,
	NetworkIngest,
	PipelineAudioKind,
	RequiresGateway,
	Resolution,
	SourcesMessage,
	StreamSource,
	StreamSourceBase,
} from "@ceraui/rpc/schemas";
import { framerateSchema, resolutionSchema } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { broadcastMsg } from "../../rpc/compat.ts";
import { getNetworkIngestInfo } from "../network/network-ingest.ts";
import type { EngineAudioDevice } from "./audio-naming.ts";
import {
	defaultFetchEngineDevices,
	getLastCapabilities,
	groupDeviceCaps,
} from "./capabilities.ts";
import { fromEngineDevice } from "./devices.ts";
import { getEffectiveHardware } from "./pipelines.ts";

/** One entry of the engine capability contract's `sources[]` array. */
type CapabilitySource = GetCapabilitiesResult["sources"][number];

/** Source ids that ingest over a local network gateway (mirrors pipelines.ts). */
const NETWORK_SOURCE_IDS: Record<string, RequiresGateway> = {
	rtmp: "rtmp",
	srt: "srt",
};

/** The single virtual source id (the test pattern). */
const VIRTUAL_SOURCE_ID = "test";

/** The i18n reason surfaced when a network gateway is not running. */
const GATEWAY_INACTIVE_REASON = "live.education.reason.gatewayInactive";

/** The i18n reason surfaced when the operator disabled the protocol in Settings. */
const DISABLED_IN_SETTINGS_REASON = "live.education.reason.disabledInSettings";

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
): StreamSource {
	const base = baseFacets(cap);
	if (cap.id === VIRTUAL_SOURCE_ID) {
		return { ...base, origin: "virtual", labelKey: sourceLabelKey(cap.id) };
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

/** Build one concrete `capture` entry, inheriting facets from its coarse entry. */
function buildCaptureEntry(
	device: CaptureDevice,
	pipelineId: string,
	coarse: StreamSource,
): StreamSource {
	return {
		id: device.input_id,
		pipelineId,
		modes: device.caps !== undefined ? groupDeviceCaps(device.caps) : [],
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
	};
}

export interface BuildSourcesInput {
	/** The engine capability contract's `sources[]` (the coarse offering). */
	sources: readonly CapabilitySource[];
	/** Concrete engine devices from the cache (video + audio; audio is ignored). */
	devices: readonly CaptureDevice[];
	/** The network-ingest gateway snapshot (rtmp/srt availability + LAN url). */
	networkIngest: NetworkIngest;
}

/**
 * Fold caps.sources + the engine-device cache + the network-ingest snapshot into
 * ONE StreamSource[]. Caps-first: every capability source is a base entry; a
 * bridgeable engine device then REPLACES the coarse entry it bridges to.
 */
export function buildSources(input: BuildSourcesInput): StreamSource[] {
	// (a) BASE — one entry per capability source, in contract order.
	const base = input.sources.map((cap) =>
		buildBaseEntry(cap, input.networkIngest),
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

	const capturesByPipeline = new Map<string, StreamSource[]>();
	for (const device of input.devices) {
		if (device.media_class !== "video") continue;
		const bridged = deviceKindToPipelineId(device.kind);
		if (bridged === undefined) continue;
		const coarse = coarseByPipeline.get(bridged);
		if (coarse === undefined) continue;
		const list = capturesByPipeline.get(bridged) ?? [];
		list.push(buildCaptureEntry(device, bridged, coarse));
		capturesByPipeline.set(bridged, list);
	}

	// (c) MERGE — replace each bridged coarse entry (in place, preserving order)
	// with its capture entries; every other base entry passes through unchanged.
	const out: StreamSource[] = [];
	for (const entry of base) {
		if (entry.origin === "coarse") {
			const captures = capturesByPipeline.get(entry.pipelineId);
			if (captures !== undefined && captures.length > 0) {
				out.push(...captures);
				continue;
			}
		}
		out.push(entry);
	}
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
): EngineRouting | undefined {
	const source = sources.find((s) => s.id === sourceId);
	if (source === undefined) return undefined;
	if (source.origin === "capture") {
		return { pipeline: source.pipelineId, selected_video_input: source.id };
	}
	return { pipeline: source.pipelineId, selected_video_input: undefined };
}

export const UNKNOWN_SOURCE_ERROR = "unknown_source";

export type ResolveSourceRoutingResult =
	| { ok: true; pipeline: string; selected_video_input: string | undefined }
	| { ok: false; error: typeof UNKNOWN_SOURCE_ERROR };

// Procedure-layer wrapper over deriveEngineRouting. Unknown id → `unknown_source`
// so the procedure rejects with disk unchanged (session.start swallows
// updateConfig errors, so this must be enforced here, never deeper). Known id →
// routing whose `selected_video_input` is the capture input_id, or `undefined`
// (config-clear) for coarse/virtual/network — clearing a stale capture input.
export function resolveSourceRouting(
	sourceId: string,
	sources: readonly StreamSource[],
): ResolveSourceRoutingResult {
	const routing = deriveEngineRouting(sourceId, sources);
	if (routing === undefined) {
		return { ok: false, error: UNKNOWN_SOURCE_ERROR };
	}
	return {
		ok: true,
		pipeline: routing.pipeline,
		selected_video_input: routing.selected_video_input,
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

/**
 * Refresh the engine-device cache from a fresh `list-devices` probe. A throwing
 * fetch (engine unavailable) RETAINS the prior cache — the last-known device list
 * is never lost to a transient outage. A successful fetch replaces the cache
 * wholesale (an empty live list legitimately clears it — that is a reachable
 * engine reporting no devices, NOT an outage).
 */
export async function refreshEngineDeviceCache(
	deps: EngineDeviceCacheDeps = defaultEngineDeviceCacheDeps,
): Promise<CaptureDevice[]> {
	try {
		const result = await deps.fetchEngineDevices();
		engineDeviceCache = result.devices.map((d) =>
			fromEngineDevice({
				input_id: d.input_id,
				device_path: d.device_path,
				display_name: d.display_name,
				media_class: d.media_class,
				kind: d.kind,
				caps: d.caps,
			}),
		);
		// Parallel AUDIO cache (T4): an EXPLICIT field copy of the audio entries
		// that PRESERVES the `alsa_card_id` join key verbatim. It is read
		// defensively (the pre-T18 binding schema strips it → `undefined`; the
		// bumped schema retains it), and it is NOT routed through the video
		// whitelist copy above or `fromEngineDevice()`, both of which drop it.
		engineAudioDeviceCache = result.devices
			.filter((d) => d.media_class === "audio")
			.map((d) => {
				const alsaCardId = (d as { alsa_card_id?: string }).alsa_card_id;
				return {
					input_id: d.input_id,
					display_name: d.display_name,
					...(alsaCardId !== undefined ? { alsa_card_id: alsaCardId } : {}),
				};
			});
	} catch (err) {
		logger.debug(
			"sources: engine device fetch failed; retaining last-known device cache",
			{ err },
		);
	}
	return engineDeviceCache;
}

/** Drop the cached engine device lists (video + audio) for test isolation. */
export function resetEngineDeviceCache(): void {
	engineDeviceCache = [];
	engineAudioDeviceCache = [];
}

// ─── Broadcast wiring (rides the existing `sources` bus, no new endpoint) ─────

/** Build the `sources` broadcast payload from the live caches (synchronous). */
export function getSourcesMessage(): SourcesMessage {
	const caps = getLastCapabilities();
	const sources = buildSources({
		sources: caps?.sources ?? [],
		devices: getEngineDeviceCache(),
		networkIngest: getNetworkIngestInfo(),
	});
	return { hardware: getEffectiveHardware(), sources };
}

/** Push the current `sources` snapshot to all authenticated clients. */
export function broadcastSources(): void {
	broadcastMsg("sources", getSourcesMessage());
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
