/**
 * sourceSummary — pure helpers for the unified Source surface (Task 8).
 *
 * The Live destination's "Source" section composes the existing hotplug video
 * picker with the pipeline-reported audio sources and a compact capability
 * summary. These derivations are PURE (no runes, no RPC, no Svelte) so the
 * single-vs-multiple audio rendering decision and the capability summary can be
 * unit-tested in isolation, and the component stays presentational.
 */
import type {
	ActiveEncode,
	CapabilitiesMessage,
	ConfigMessage,
} from "@ceraui/rpc/schemas";
import { fromEngineResolution } from "@ceraui/rpc/schemas";

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

/** Compact, structured capability summary for the active source's platform. */
export interface CapabilitySummary {
	/** Platform max resolution token (e.g. `1080p`, `4k`) — already display-ready. */
	maxResolution: string | undefined;
	/** Highest default framerate advertised across the reported sources. */
	maxFramerate: number | undefined;
	/** Engine encoder codecs (raw tokens, e.g. `h264`, `h265`). */
	codecs: string[];
	/** Whether the encode path is hardware-accelerated on this board. */
	hardwareAccelerated: boolean;
	/** Whether at least one reported source exposes audio capture. */
	audioSupported: boolean;
}

/**
 * Derive the compact capability summary from the engine capability broadcast.
 * Returns `undefined` when no capabilities have been received yet, so the
 * caller can omit the summary rather than render misleading empty values.
 */
export function deriveCapabilitySummary(
	caps: CapabilitiesMessage | undefined,
): CapabilitySummary | undefined {
	if (!caps) return undefined;

	const sources = caps.sources ?? [];
	const framerates = sources
		.map((s) => s.default_framerate)
		.filter(
			(fps): fps is number => typeof fps === "number" && Number.isFinite(fps),
		);

	return {
		maxResolution: caps.platform?.max_resolution || undefined,
		maxFramerate: framerates.length ? Math.max(...framerates) : undefined,
		codecs: caps.encoder?.codecs ?? [],
		hardwareAccelerated: caps.platform?.hardware_accelerated ?? false,
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
	/** Resolved source/input label (engine `active_input`, else saved input/pipeline). */
	source: string | undefined;
	/** Display resolution — a token (`1080p`) when resolvable, else the raw `WxH`. */
	resolution: string | undefined;
	framerate: number | undefined;
	/** Human codec label (`H.265`); undefined when neither engine nor config set one. */
	codec: string | undefined;
	/** Relay transport token (`SRTLA`). */
	transport: string;
}

/**
 * Derive the active-encode summary, preferring engine truth (`activeEncode`,
 * present only while streaming) over the saved `config` (idle). Pure and
 * defensive: a missing config, active_encode, or capability snapshot degrades to
 * `undefined` fields (never a fabricated or capability-derived value), except the
 * transport token which always resolves (SRTLA floor).
 */
export function deriveActiveSummary(
	config: ConfigMessage | undefined,
	activeEncode: ActiveEncode | null | undefined,
	caps: CapabilitiesMessage | undefined,
): ActiveSummary {
	const live = Boolean(activeEncode);

	const source = live
		? (activeEncode?.active_input ??
			config?.selected_video_input ??
			config?.pipeline)
		: (config?.selected_video_input ?? config?.pipeline);

	const resolution = live
		? (fromEngineResolution(activeEncode?.resolution ?? "") ??
			activeEncode?.resolution)
		: config?.resolution;

	const framerate = live ? activeEncode?.framerate : config?.framerate;

	const codecToken = live ? activeEncode?.codec : config?.video_codec;

	return {
		live,
		source: source || undefined,
		resolution: resolution || undefined,
		framerate: typeof framerate === "number" ? framerate : undefined,
		codec: codecToken ? formatCodec(codecToken) : undefined,
		transport: resolveTransportToken(config, caps),
	};
}
