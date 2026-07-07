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
	DevicesMessage,
	Framerate,
	NetworkIngest,
	PipelineAudioKind,
	RequiresGateway,
	Resolution,
	SourcesMessage,
	SourcesVisibility,
	StreamSource,
	StreamSourceBase,
} from "@ceraui/rpc/schemas";
import { framerateSchema, resolutionSchema } from "@ceraui/rpc/schemas";
import type { LastSeenDevice } from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { broadcastMsg } from "../../rpc/compat.ts";
import { getConfig, saveConfig } from "../config.ts";
import { getNetworkIngestInfo } from "../network/network-ingest.ts";
import type { EngineAudioDevice } from "./audio-naming.ts";
import {
	defaultFetchEngineDevices,
	getLastCapabilities,
	groupDeviceCaps,
} from "./capabilities.ts";
import { fromEngineDevice } from "./devices.ts";
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

/**
 * Build one `lost` capture row from a remembered snapshot (C7): a device we saw
 * this session, or the configured device across a restart, that is absent from
 * the current engine list. It inherits facets from its still-offered coarse entry
 * and is always `available:false` + `lost:true` — the frontend renders the
 * unplugged grace state (`live.source.lostBody`) and a start/setConfig is refused
 * by the todo-12 gate.
 */
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
		displayName: snapshot.displayName,
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
	/** The operator's persisted `config.source` id; drives the across-restart
	 *  lost row for the configured device. Absent → no config-driven lost row. */
	configSource?: string;
	/** Persisted `config.last_seen_devices`; the metadata source for the
	 *  across-restart configured-device lost row. Absent → treated as empty. */
	lastSeenDevices?: readonly LastSeenDevice[];
	/** In-memory session snapshots; the metadata source for in-session lost rows
	 *  (uncapped, so LRU churn never orphans a session-seen id). */
	sessionSnapshots?: ReadonlyMap<string, LastSeenDevice>;
}

/**
 * The remembered snapshots eligible to become a lost row: every in-session
 * snapshot, plus the configured id's persisted snapshot across a restart (the
 * session map is empty then). Deduped by id — a session snapshot wins over its
 * persisted twin (same metadata; the session copy is the freshest).
 */
function collectLostCandidates(input: BuildSourcesInput): LastSeenDevice[] {
	const candidates = new Map<string, LastSeenDevice>();
	if (input.sessionSnapshots !== undefined) {
		for (const [id, snapshot] of input.sessionSnapshots)
			candidates.set(id, snapshot);
	}
	const configSource = input.configSource;
	if (configSource !== undefined && !candidates.has(configSource)) {
		const persisted = (input.lastSeenDevices ?? []).find(
			(d) => d.id === configSource,
		);
		if (persisted !== undefined) candidates.set(configSource, persisted);
	}
	return [...candidates.values()];
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

	const capturesByPipeline = new Map<string, StreamSource[]>();
	const liveVideoIds = new Set<string>();
	for (const device of input.devices) {
		if (device.media_class !== "video") continue;
		liveVideoIds.add(device.input_id);
		const bridged = deviceKindToPipelineId(device.kind);
		if (bridged === undefined) continue;
		const coarse = coarseByPipeline.get(bridged);
		if (coarse === undefined) continue;
		const list = capturesByPipeline.get(bridged) ?? [];
		list.push(buildCaptureEntry(device, bridged, coarse));
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
// A remembered capture row (C7 `lost:true`) — the device was unplugged and is no
// longer in the current engine list. Refused at the dispatch choke point.
export const SOURCE_LOST_ERROR = "source_lost";
// A listed-but-unavailable source (`available:false` without `lost`): an
// operator-disabled / gateway-down network row, or a hidden test pattern.
export const SOURCE_UNAVAILABLE_ERROR = "source_unavailable";

export type ResolveSourceRoutingResult =
	| { ok: true; pipeline: string; selected_video_input: string | undefined }
	| {
			ok: false;
			error:
				| typeof UNKNOWN_SOURCE_ERROR
				| typeof SOURCE_LOST_ERROR
				| typeof SOURCE_UNAVAILABLE_ERROR;
	  };

// Procedure-layer wrapper over deriveEngineRouting. Reads the CURRENT sources
// snapshot at dispatch time, so a re-listed (recovered) device passes; every
// rejection leaves disk unchanged (session.start swallows updateConfig errors, so
// it must be enforced here). The `lost` check MUST precede the `available` check —
// a lost row is ALSO available:false, and it needs the distinct `source_lost`
// code. Absent → `unknown_source` (semantics unchanged). Never mutates config.
export function resolveSourceRouting(
	sourceId: string,
	sources: readonly StreamSource[],
): ResolveSourceRoutingResult {
	const source = sources.find((s) => s.id === sourceId);
	if (source === undefined) {
		return { ok: false, error: UNKNOWN_SOURCE_ERROR };
	}
	if (source.lost === true) {
		return { ok: false, error: SOURCE_LOST_ERROR };
	}
	if (source.available === false) {
		return { ok: false, error: SOURCE_UNAVAILABLE_ERROR };
	}
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

/** The persisted last-seen list cap (C7). The current `config.source` id is
 *  exempt from eviction, so the configured device's snapshot survives churn. */
const LAST_SEEN_DEVICES_CAP = 12;

// The IN-MEMORY session-seen snapshot map (C7): every bridgeable video input_id
// ever returned by a successful `list-devices` this process lifetime, keyed to its
// snapshot. UNCAPPED and monotonic — an empty list never clears it (distinct from
// the replaceable engineDeviceCache), and only `resetEngineDeviceCache()` drops it
// (test isolation). It is the metadata source for IN-SESSION lost rows, so LRU
// churn on the persisted cap can never orphan a session-seen id.
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
	};
}

/**
 * LRU-merge freshly-observed snapshots into the persisted last-seen list:
 * most-recently-observed first, then prior entries not re-observed. Over the cap,
 * evict least-recent from the tail — EXCEPT the configured id, which is pulled out
 * and always kept so the configured device's snapshot survives any churn.
 */
function mergeLastSeenLru(
	current: readonly LastSeenDevice[],
	observed: readonly LastSeenDevice[],
	configSource: string | undefined,
): LastSeenDevice[] {
	const observedIds = new Set(observed.map((d) => d.id));
	const ordered: LastSeenDevice[] = [
		...observed,
		...current.filter((d) => !observedIds.has(d.id)),
	];
	if (ordered.length <= LAST_SEEN_DEVICES_CAP) return ordered;

	const configuredIndex =
		configSource === undefined
			? -1
			: ordered.findIndex((d) => d.id === configSource);
	const configured =
		configuredIndex === -1 ? undefined : ordered[configuredIndex];
	if (configured === undefined) return ordered.slice(0, LAST_SEEN_DEVICES_CAP);

	const rest = ordered.filter((_, i) => i !== configuredIndex);
	const kept = rest.slice(0, LAST_SEEN_DEVICES_CAP - 1);
	kept.splice(Math.min(configuredIndex, kept.length), 0, configured);
	return kept;
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
	const next = mergeLastSeenLru(current, snapshots, config.source);
	if (JSON.stringify(current) === JSON.stringify(next)) return;
	config.last_seen_devices = next;
	saveConfig();
}

/** The in-memory session-seen snapshots (C7): the metadata source for in-session
 *  lost rows. Read by `getSourcesMessage`; exposed for wiring and tests. */
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
		recordObservedDevices(engineDeviceCache);
	} catch (err) {
		logger.debug(
			"sources: engine device fetch failed; retaining last-known device cache",
			{ err },
		);
	}
	return engineDeviceCache;
}

/** Drop the cached engine device lists (video + audio) AND the session-seen
 *  snapshot map for test isolation (restart simulation). */
export function resetEngineDeviceCache(): void {
	engineDeviceCache = [];
	engineAudioDeviceCache = [];
	sessionSeenDeviceSnapshots.clear();
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
	engineDeviceCache = [...devices];
	recordObservedDevices(engineDeviceCache);
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
	const sources = buildSources({
		sources: caps?.sources ?? [],
		devices: getEngineDeviceCache(),
		networkIngest: getNetworkIngestInfo(),
		...(sourcesVisibility !== undefined ? { sourcesVisibility } : {}),
		...(config.source !== undefined ? { configSource: config.source } : {}),
		lastSeenDevices: config.last_seen_devices ?? [],
		sessionSnapshots: sessionSeenDeviceSnapshots,
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
