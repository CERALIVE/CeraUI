import {
	type Pipelines,
	type Pipeline,
	type Resolution,
	type Framerate,
	type HardwareType,
	HARDWARE_LABELS,
	VIDEO_SOURCE_LABELS,
} from "@ceraui/rpc/schemas";

type VideoSource = keyof typeof VIDEO_SOURCE_LABELS;

export type { Pipeline, Resolution, Framerate };

// Safe fallback for unknown ids — never surface the raw/uppercased ceracoder hash.
const UNKNOWN_SOURCE_LABEL = "Unknown source";

function resolveUnknownSourceLabel(t?: (key: string) => string): string {
	if (t) {
		const translated = t("general.unknownSource");
		if (translated && !translated.includes("general.unknownSource")) {
			return translated;
		}
	}
	return UNKNOWN_SOURCE_LABEL;
}

// Re-export for convenience
export { VIDEO_SOURCE_LABELS, HARDWARE_LABELS };
export type { VideoSource, HardwareType };

/**
 * Get a human-readable label for a video source
 * Falls back to ceracoder bindings labels if no translation function provided
 */
export function getSourceLabel(source: string, t?: (key: string) => string): string {
	// Try translation first if provided
	if (t) {
		const translated = t(`settings.sources.${source}`);
		// If translation exists and is not the key itself
		if (translated && !translated.includes("settings.sources.")) {
			return translated;
		}
	}
	// Fall back to ceracoder bindings labels
	return VIDEO_SOURCE_LABELS[source as VideoSource] || resolveUnknownSourceLabel(t);
}

/**
 * Resolve a display name for a pipeline id (video source key or opaque ceracoder id).
 * Pure: prefers the friendly source label, then pipeline metadata, then a safe
 * fallback. Returns "" for an undefined id and never leaks the raw id.
 */
export function getPipelineDisplayName(
	id: string | undefined,
	pipelines?: Pipelines,
	t?: (key: string) => string,
): string {
	if (!id) return "";
	if (VIDEO_SOURCE_LABELS[id as VideoSource]) return getSourceLabel(id, t);
	const pipeline = pipelines?.[id];
	if (pipeline?.name) return pipeline.name;
	if (pipeline?.description) return pipeline.description;
	return resolveUnknownSourceLabel(t);
}

/**
 * Get a human-readable label for a hardware type
 * Falls back to ceracoder bindings labels if no translation function provided
 */
export function getHardwareLabel(hardware: string, t?: (key: string) => string): string {
	// Try translation first if provided
	if (t) {
		const translated = t(`settings.hardwareTypes.${hardware}`);
		// If translation exists and is not the key itself
		if (translated && !translated.includes("settings.hardwareTypes.")) {
			return translated;
		}
	}
	// Fall back to ceracoder bindings labels
	return HARDWARE_LABELS[hardware as HardwareType] || hardware.toUpperCase();
}

/**
 * Get a human-readable label for a resolution
 */
export function getResolutionLabel(resolution: Resolution): string {
	const labels: Record<Resolution, string> = {
		"480p": "480p (854×480)",
		"720p": "720p (1280×720)",
		"1080p": "1080p (1920×1080)",
		"1440p": "1440p (2560×1440)",
		"2160p": "4K (3840×2160)",
		"4k": "4K (3840×2160)",
	};
	return labels[resolution] || resolution;
}

/**
 * Get a human-readable label for a framerate
 */
export function getFramerateLabel(framerate: Framerate): string {
	if (framerate === 29.97) return "29.97 fps (NTSC)";
	if (framerate === 59.94) return "59.94 fps (NTSC)";
	return `${framerate} fps`;
}

/**
 * Sort resolutions from lowest to highest
 */
export function sortResolutions(resolutions: Resolution[]): Resolution[] {
	const order: Resolution[] = ["480p", "720p", "1080p", "1440p", "2160p", "4k"];
	return resolutions.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * Sort framerates from lowest to highest
 */
export function sortFramerates(framerates: Framerate[]): Framerate[] {
	return [...framerates].sort((a, b) => a - b);
}

/**
 * Get pipelines as a sorted array with IDs
 */
export function getPipelineArray(pipelines: Pipelines): Array<{ id: string } & Pipeline> {
	return Object.entries(pipelines)
		.map(([id, pipeline]) => ({ id, ...pipeline }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Check if a pipeline supports audio configuration
 */
export function supportsAudio(pipeline: Pipeline): boolean {
	return pipeline.supportsAudio;
}

/**
 * Get the default resolution for a pipeline, or a fallback
 */
export function getDefaultResolution(pipeline: Pipeline): Resolution {
	return pipeline.defaultResolution || "1080p";
}

/**
 * Get the default framerate for a pipeline, or a fallback
 */
export function getDefaultFramerate(pipeline: Pipeline): Framerate {
	return pipeline.defaultFramerate || 30;
}
