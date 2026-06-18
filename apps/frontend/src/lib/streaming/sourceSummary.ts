/**
 * sourceSummary — pure helpers for the unified Source surface (Task 8).
 *
 * The Live destination's "Source" section composes the existing hotplug video
 * picker with the pipeline-reported audio sources and a compact capability
 * summary. These derivations are PURE (no runes, no RPC, no Svelte) so the
 * single-vs-multiple audio rendering decision and the capability summary can be
 * unit-tested in isolation, and the component stays presentational.
 */
import type { CapabilitiesMessage } from "@ceraui/rpc/schemas";

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
