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
