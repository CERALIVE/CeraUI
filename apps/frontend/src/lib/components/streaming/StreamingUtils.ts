import type { HumanReadablePipeline } from "$lib/helpers/PipelineHelper";
import { updateBitrate } from "$lib/helpers/SystemHelper";

export function normalizeValue(
	value: number,
	min: number,
	max: number,
	step = 1,
): number {
	// Validate inputs to prevent NaN propagation
	if (
		!Number.isFinite(value) ||
		!Number.isFinite(min) ||
		!Number.isFinite(max) ||
		!Number.isFinite(step)
	) {
		return Number.isFinite(min) ? min : 0;
	}

	if (step === 0) {
		return Math.max(min, Math.min(max, value));
	}

	const stepped = Math.round((value - min) / step) * step + min;
	const result = Math.max(min, Math.min(max, stepped));

	return Number.isFinite(result) ? result : min;
}

export function updateMaxBitrate(
	bitrate: number | undefined,
	isStreaming: boolean | undefined,
): void {
	if (isStreaming && bitrate) {
		updateBitrate(bitrate);
	}
}

export function getSortedFramerates(
	framerates: HumanReadablePipeline[],
): HumanReadablePipeline[] {
	return [...framerates].sort((a, b) => {
		// Put "match device output" or similar special options first
		const fpsA = a.extraction.fps;
		const fpsB = b.extraction.fps;

		if (typeof fpsA === "string" && fpsA.toLowerCase().includes("match"))
			return -1;
		if (typeof fpsB === "string" && fpsB.toLowerCase().includes("match"))
			return 1;

		// Convert to numbers for numeric comparison with NaN safety
		const numA = parseFloat(String(fpsA));
		const numB = parseFloat(String(fpsB));
		const safeNumA = Number.isFinite(numA) ? numA : 0;
		const safeNumB = Number.isFinite(numB) ? numB : 0;

		// Sort by numeric value
		return safeNumA - safeNumB;
	});
}

export function getSortedResolutions(resolutions: string[]): string[] {
	return [...resolutions].sort((a, b) => {
		// Put "match device resolution" or similar special options first
		if (a.toLowerCase().includes("match") || a.toLowerCase().includes("device"))
			return -1;
		if (b.toLowerCase().includes("match") || b.toLowerCase().includes("device"))
			return 1;

		// Extract numeric values (like "720" from "720p") with NaN safety
		const numA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
		const numB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
		const safeNumA = Number.isFinite(numA) ? numA : 0;
		const safeNumB = Number.isFinite(numB) ? numB : 0;

		// Sort by numeric value
		return safeNumA - safeNumB;
	});
}
