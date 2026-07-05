/**
 * sourceSummary — pure helpers for the unified Source surface (Task 8).
 *
 * The Live destination's "Source" section composes the existing hotplug video
 * picker with the pipeline-reported audio sources and a compact capability
 * summary. These derivations are PURE (no runes, no RPC, no Svelte) so the
 * single-vs-multiple audio rendering decision and the capability summary can be
 * unit-tested in isolation, and the component stays presentational.
 */
import { intersectCaps, type VideoSourceCap } from "@ceraui/rpc";
import type {
	ActiveEncode,
	AudioSource,
	CapabilitiesMessage,
	ConfigMessage,
	ResolvedAsrcReason,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { AUDIO_SOURCE_AUTO, fromEngineResolution } from "@ceraui/rpc/schemas";

import {
	axisCeiling,
	resolveDeviceModes,
	STREAMING_MODE,
} from "$lib/components/streaming/ValidationAdapter";

/**
 * How the audio-source control should render:
 * - `none`     → no pipeline-reported sources; show an explanatory placeholder.
 * - `single`   → exactly one source; render READ-ONLY (no misleading dropdown).
 * - `multiple` → 2+ sources; render a selectable control (pre-start only).
 */
export type AudioSourceMode = "none" | "single" | "multiple";

export function resolveAudioSourceMode(
	sources: readonly string[],
): AudioSourceMode {
	if (sources.length === 0) return "none";
	return sources.length === 1 ? "single" : "multiple";
}

/**
 * The effective audio source to display: the explicit selection when present
 * and still reported, otherwise the lone source in single mode (which the
 * operator cannot change, so it is implicitly active).
 */
export function resolveDisplayedAudioSource(
	selected: string | undefined,
	sources: readonly string[],
): string | undefined {
	if (selected && sources.includes(selected)) return selected;
	if (sources.length === 1) return sources[0];
	return selected || undefined;
}

// The two pseudo-source wire ids (byte-equal to the backend `config.asrc`
// sentinels). Used to derive the typed model from a legacy `asrcs` string list
// when the backend does not carry `audio_sources`.
const AUDIO_SOURCE_NO_AUDIO = "No audio";
const AUDIO_SOURCE_PIPELINE_DEFAULT = "Pipeline default";

/**
 * The typed audio-source list, from the backend `audio_sources` when present, or
 * derived from the legacy `asrcs` string list (older backend) — mirroring the
 * backend `deriveAudioSources` mapping so the frontend model is identical either
 * way. `id` stays byte-equal to the `asrcs` entry, so `config.asrc` is unchanged.
 */
export function resolveAudioSourceList(
	audioSources: readonly AudioSource[] | undefined,
	asrcs: readonly string[],
): AudioSource[] {
	if (audioSources && audioSources.length > 0) return [...audioSources];
	return asrcs.map((id): AudioSource => {
		if (id === AUDIO_SOURCE_NO_AUDIO) {
			return { id, kind: "none", labelKey: "audio.sources.noAudio" };
		}
		if (id === AUDIO_SOURCE_PIPELINE_DEFAULT) {
			return {
				id,
				kind: "pipeline_default",
				labelKey: "audio.sources.pipelineDefault",
			};
		}
		return { id, kind: "device" };
	});
}

/**
 * Split the typed list into device entries (kept in backend priority order —
 * meaningful, never reordered) and the pseudo-sources, which the picker groups at
 * the END of the list, visually muted.
 */
export function groupAudioSources(list: readonly AudioSource[]): {
	devices: AudioSource[];
	pseudo: AudioSource[];
} {
	const devices: AudioSource[] = [];
	const pseudo: AudioSource[] = [];
	for (const entry of list) {
		if (entry.kind === "device") devices.push(entry);
		else pseudo.push(entry);
	}
	return { devices, pseudo };
}

/**
 * Display label for an audio-source entry. Preference order (T6):
 *   1. `entry.label` — the verbatim hardware name resolved by the backend (T4);
 *      wins when present, NEVER translated.
 *   2. `entry.labelKey` — the translated pseudo-source label (Auto / No audio /
 *      Pipeline default).
 *   3. `entry.id` — the raw wire id, for a legacy device entry with no label.
 */
export function audioSourceLabel(
	entry: AudioSource,
	t: (key: string) => string,
): string {
	return entry.label ?? (entry.labelKey ? t(entry.labelKey) : entry.id);
}

/**
 * The FE-injected "Auto" audio-source entry (plan decision 2b). The backend NEVER
 * emits an `auto`-kind entry — this is a frontend-only affordance that opts the
 * device into the T5 auto-resolution path by writing `asrc = AUDIO_SOURCE_AUTO`.
 * `id` is byte-equal to the wire sentinel so `config.asrc === AUDIO_SOURCE_AUTO`.
 */
export const AUTO_AUDIO_SOURCE_ENTRY: AudioSource = {
	id: AUDIO_SOURCE_AUTO,
	kind: "auto",
	labelKey: "audio.sources.auto",
};

/**
 * Prepend the FE-injected Auto entry so it renders FIRST in the picker, above the
 * device entries. Deduped defensively: if a (future) backend ever emitted an Auto
 * entry, the injected one still wins and there is never a duplicate.
 */
export function withAutoAudioEntry(
	entries: readonly AudioSource[],
): AudioSource[] {
	return [
		AUTO_AUDIO_SOURCE_ENTRY,
		...entries.filter((entry) => entry.id !== AUDIO_SOURCE_AUTO),
	];
}

/**
 * The three T5 resolution fields carried on the `status` broadcast. Structural
 * subset of `StatusResponse` so any status object satisfies it — the consumer
 * passes `getStatus()` verbatim. All nullable/optional: null/absent = no Auto
 * resolution yet, or an old backend that never broadcasts these fields.
 */
export interface ResolvedAudioStatus {
	resolved_asrc?: string | null;
	resolved_asrc_reason?: ResolvedAsrcReason | null;
	pending_audio_follow_asrc?: string | null;
}

/** The single resolved-audio display model every consuming surface renders from. */
export interface ResolvedAudioDisplay {
	/**
	 * `"Auto → {label}"` when Auto is the ACTIVE selection AND the backend has
	 * resolved a concrete device (`resolved_asrc` non-null). `undefined` when Auto
	 * is not active (stale-value gate) or Auto is active but genuinely unresolved
	 * (null `resolved_asrc` WITHOUT the embedded reason — e.g. an old backend).
	 */
	current: string | undefined;
	/** The deferred live-follow target label (T7's `pending_audio_follow_asrc`). */
	pending: string | undefined;
	/** `true` when the resolution reason is `embedded` (network-ingest muxed audio). */
	embedded: boolean;
}

/**
 * The ONE owner of the resolved-audio display (Metis F12 + Oracle R5-1/R9-1). Pure;
 * every surface — SourceSection, LiveView `audioSummary`, AudioDialog's read-only
 * line, (later) LiveSummaryStrip — routes through this rather than re-deriving it.
 *
 * STALE-VALUE GATE (Oracle R11): `current` is ALWAYS `undefined` when
 * `config?.asrc !== AUDIO_SOURCE_AUTO`, REGARDLESS of what `status.resolved_asrc`
 * currently holds — a leftover broadcast value from a prior Auto session must never
 * render once the operator has picked an explicit device.
 *
 * The two null cases stay VISUALLY DISTINCT via `embedded`:
 *   • `{resolved_asrc:null, resolved_asrc_reason:'embedded'}` → `embedded:true`
 *     (surfaces the existing "Embedded audio" state).
 *   • `{resolved_asrc:null, resolved_asrc_reason:null/absent}` → `embedded:false`,
 *     `current:undefined` (the em-dash / old-backend state).
 */
export function resolvedAudioLabel(
	config: ConfigMessage | undefined,
	status: ResolvedAudioStatus | undefined,
	audioSourceEntries: readonly AudioSource[],
	t: (key: string) => string,
): ResolvedAudioDisplay {
	const embedded = status?.resolved_asrc_reason === "embedded";

	// Resolve an asrc key/id to a display label via the typed entries (the T4
	// hardware name wins through audioSourceLabel), else the raw id verbatim.
	const labelFor = (id: string): string => {
		const entry = audioSourceEntries.find((e) => e.id === id);
		return entry ? audioSourceLabel(entry, t) : id;
	};

	// The deferred live-follow target is independent of the stale gate — it is a
	// separate slot (T7's only writer; null until then, so this stays undefined).
	const pendingId = status?.pending_audio_follow_asrc;
	const pending = pendingId ? labelFor(pendingId) : undefined;

	if (config?.asrc !== AUDIO_SOURCE_AUTO) {
		return { current: undefined, pending, embedded };
	}

	const resolved = status?.resolved_asrc;
	const current = resolved
		? `${AUDIO_SOURCE_AUTO} \u2192 ${labelFor(resolved)}`
		: undefined;
	return { current, pending, embedded };
}

/** Compact, structured capability summary for the ACTIVE source (Todo 11). */
export interface CapabilitySummary {
	/**
	 * Max resolution token (e.g. `1080p`, `2160p`) — the ACTIVE source's real
	 * ceiling (its device modes when present, else its platform-intersected
	 * override ceiling), falling back to the platform maximum only when no source
	 * resolves. Already display-ready.
	 */
	maxResolution: string | undefined;
	/** Highest framerate the ACTIVE source can drive (platform max on fallback). */
	maxFramerate: number | undefined;
	/** Engine encoder codecs (raw tokens, e.g. `h264`, `h265`) — encoder-level. */
	codecs: string[];
	/** Whether the encode path is hardware-accelerated on this board. */
	hardwareAccelerated: boolean;
	/** Whether the ACTIVE source exposes audio capture (any source on fallback). */
	audioSupported: boolean;
}

/**
 * Resolve the ACTIVE source's `VideoSourceCap` from the saved config. The
 * explicitly selected input wins (matched against the capability `sources[]` ids),
 * then the configured pipeline. Returns `undefined` when neither resolves to a
 * reported source — the summary then falls back to platform maxima.
 */
function resolveActiveSourceCap(
	sources: readonly VideoSourceCap[],
	config: ConfigMessage | undefined,
): VideoSourceCap | undefined {
	if (config?.selected_video_input) {
		const bySelected = sources.find(
			(s) => s.id === config.selected_video_input,
		);
		if (bySelected) return bySelected;
	}
	if (config?.pipeline) {
		return sources.find((s) => s.id === config.pipeline);
	}
	return undefined;
}

/**
 * Derive the compact capability summary from the engine capability broadcast and
 * the saved config. Returns `undefined` when no capabilities have been received
 * yet, so the caller can omit the summary rather than render misleading empty
 * values.
 *
 * Todo 11 — the chip ceiling is ACTIVE-SOURCE-truthful: when the configured
 * source resolves, `maxResolution`/`maxFramerate` reflect THAT source's real
 * ceiling (its `device_modes` intersected with the platform via the same
 * {@link intersectCaps}/{@link axisCeiling} path the EncoderDialog uses), and
 * `audioSupported` reflects THAT source's `supports_audio` — never "any source".
 * When no source resolves, it preserves the original platform-maxima behavior as
 * the fallback branch. Codecs stay encoder-level in both branches.
 */
export function deriveCapabilitySummary(
	caps: CapabilitiesMessage | undefined,
	config?: ConfigMessage | undefined,
): CapabilitySummary | undefined {
	if (!caps) return undefined;

	const sources = caps.sources ?? [];
	const codecs = caps.encoder?.codecs ?? [];
	const hardwareAccelerated = caps.platform?.hardware_accelerated ?? false;

	const activeSource = resolveActiveSourceCap(sources, config);

	if (activeSource) {
		const deviceModes = resolveDeviceModes(
			caps.device_modes,
			config?.pipeline,
			config?.selected_video_input,
		);
		const offered = intersectCaps(
			caps.platform,
			activeSource,
			STREAMING_MODE,
			deviceModes,
		);
		const ceiling = axisCeiling({ offered, deviceModes });
		return {
			maxResolution:
				ceiling.resolution ?? (activeSource.default_resolution || undefined),
			maxFramerate:
				ceiling.framerate ?? (activeSource.default_framerate || undefined),
			codecs,
			hardwareAccelerated,
			audioSupported: activeSource.supports_audio,
		};
	}

	const framerates = sources
		.map((s) => s.default_framerate)
		.filter(
			(fps): fps is number => typeof fps === "number" && Number.isFinite(fps),
		);

	return {
		maxResolution: caps.platform?.max_resolution || undefined,
		maxFramerate: framerates.length ? Math.max(...framerates) : undefined,
		codecs,
		hardwareAccelerated,
		audioSupported: sources.some((s) => s.supports_audio),
	};
}

/** Format an engine codec token into a human-facing label (e.g. `h264` → `H.264`). */
export function formatCodec(codec: string): string {
	const normalized = codec.trim().toLowerCase();
	switch (normalized) {
		case "h264":
		case "avc":
			return "H.264";
		case "h265":
		case "hevc":
			return "H.265";
		case "av1":
			return "AV1";
		case "vp9":
			return "VP9";
		default:
			return codec.toUpperCase();
	}
}

/** SRTLA is the only wired bonded path — the transport-token floor. */
const SRTLA_TRANSPORT = "SRTLA";

/** Relay transport → display token. */
const TRANSPORT_TOKENS: Record<string, string> = {
	srtla: SRTLA_TRANSPORT,
	srt: "SRT",
	rist: "RIST",
};

/**
 * The active relay transport token for the configured destination. The selected
 * protocol wins only when the engine actually offers it (`caps.transports`);
 * otherwise we fall back to SRTLA — the sole always-wired bonded transport — so
 * the summary never claims a transport the engine can't honor. Pure; tolerates a
 * missing config or capability snapshot.
 */
export function resolveTransportToken(
	config: ConfigMessage | undefined,
	caps: CapabilitiesMessage | undefined,
): string {
	const protocol = config?.relay_protocol;
	const offered = caps?.transports;
	if (protocol && (!offered || offered.includes(protocol))) {
		return TRANSPORT_TOKENS[protocol] ?? protocol.toUpperCase();
	}
	return SRTLA_TRANSPORT;
}

/**
 * The ACTIVE encode configuration — what the device is actually doing (streaming)
 * or the saved config it will start with (idle). Distinct from the platform
 * CAPABILITY summary: these are settings, never the hardware ceiling.
 */
export interface ActiveSummary {
	/**
	 * `true` when the values are engine truth (`active_encode`, i.e. streaming);
	 * `false` when they are the saved config (idle). Engine truth WINS while
	 * streaming so a stale requested value is never shown as if it were active.
	 */
	live: boolean;
	/**
	 * Resolved source label — the REAL capture device name from the sources list
	 * when the active id resolves to a capture source, else the raw source/input id
	 * (engine `active_input`, else saved input/pipeline).
	 */
	source: string | undefined;
	/** Display resolution — a token (`1080p`) when resolvable, else the raw `WxH`. */
	resolution: string | undefined;
	framerate: number | undefined;
	/** Human codec label (`H.265`); undefined when neither engine nor config set one. */
	codec: string | undefined;
	/** Incoming-codec label (`H.264`) for the transcode chip; set ONLY for a network source with a reported `input_codec` (else undefined). */
	inputCodec: string | undefined;
	/** Relay transport token (`SRTLA`). */
	transport: string;
}

/**
 * Resolve a source/input id to its display label: the REAL hardware `displayName`
 * when the id matches a capture source in the sources list, else the raw id
 * (coarse/virtual/network keep their id — this pure module has no translator).
 * With no sources list the id passes through unchanged (byte-identical fallback).
 */
function resolveSourceName(
	sourceId: string | undefined,
	sources: readonly StreamSource[] | undefined,
): string | undefined {
	if (!sourceId) return undefined;
	const match = sources?.find((entry) => entry.id === sourceId);
	if (match?.origin === "capture") return match.displayName;
	return sourceId;
}

/** The `origin` of the active source id in the sources list, or undefined. */
function resolveSourceOrigin(
	sourceId: string | undefined,
	sources: readonly StreamSource[] | undefined,
): StreamSource["origin"] | undefined {
	if (!sourceId) return undefined;
	return sources?.find((entry) => entry.id === sourceId)?.origin;
}

/**
 * Derive the active-encode summary, preferring engine truth (`activeEncode`,
 * present only while streaming) over the saved `config` (idle). Pure and
 * defensive: a missing config, active_encode, or capability snapshot degrades to
 * `undefined` fields (never a fabricated or capability-derived value), except the
 * transport token which always resolves (SRTLA floor). The `source` label resolves
 * to the REAL capture device name via the `sources` list when supplied.
 */
export function deriveActiveSummary(
	config: ConfigMessage | undefined,
	activeEncode: ActiveEncode | null | undefined,
	caps: CapabilitiesMessage | undefined,
	sources?: readonly StreamSource[] | undefined,
): ActiveSummary {
	const live = Boolean(activeEncode);

	// Order: engine `active_input` (streaming) → device-first `config.source` →
	// legacy `selected_video_input`/`pipeline`. A missing `source` falls through
	// byte-identically to the prior behavior.
	const sourceId = live
		? (activeEncode?.active_input ??
			config?.source ??
			config?.selected_video_input ??
			config?.pipeline)
		: (config?.source ?? config?.selected_video_input ?? config?.pipeline);

	const resolution = live
		? (fromEngineResolution(activeEncode?.resolution ?? "") ??
			activeEncode?.resolution)
		: config?.resolution;

	const framerate = live ? activeEncode?.framerate : config?.framerate;

	const codecToken = live ? activeEncode?.codec : config?.video_codec;

	const isNetworkSource =
		resolveSourceOrigin(sourceId || undefined, sources) === "network";
	const inputCodecToken = live ? activeEncode?.input_codec : undefined;

	return {
		live,
		source: resolveSourceName(sourceId || undefined, sources),
		resolution: resolution || undefined,
		framerate: typeof framerate === "number" ? framerate : undefined,
		codec: codecToken ? formatCodec(codecToken) : undefined,
		inputCodec:
			inputCodecToken && isNetworkSource
				? formatCodec(inputCodecToken)
				: undefined,
		transport: resolveTransportToken(config, caps),
	};
}
