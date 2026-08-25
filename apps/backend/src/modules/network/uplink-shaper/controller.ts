import { SHAPER_CONFIG } from "./contracts.ts";

export interface AimdInput {
	readonly stale: boolean;
	readonly rttMs: number;
	readonly baselineRttMs: number;
	readonly nakDelta: number;
	readonly backlogBytes: number;
	readonly backlogTicks: number;
}

export interface AimdResult {
	readonly capBps: number;
	readonly congested: boolean;
	readonly held: boolean;
}

export function advanceAimd(
	currentCapBps: number,
	input: AimdInput,
): AimdResult {
	const current = clampCap(currentCapBps);
	if (input.stale) return { capBps: current, congested: false, held: true };
	const inflated =
		input.baselineRttMs > 0 &&
		input.rttMs / input.baselineRttMs >= SHAPER_CONFIG.rttInflationRatio;
	const backlogCongested =
		input.backlogBytes >= SHAPER_CONFIG.backlogThresholdBytes &&
		input.backlogTicks >= SHAPER_CONFIG.backlogCongestedTicks;
	const congested = inflated || input.nakDelta > 0 || backlogCongested;
	const capBps = congested
		? clampCap(Math.floor(current * SHAPER_CONFIG.multiplicativeDecrease))
		: clampCap(current + SHAPER_CONFIG.additiveStepBps);
	return { capBps, congested, held: false };
}

export function updateBaselineRtt(
	previousMs: number | undefined,
	sampleMs: number,
): number {
	if (!Number.isFinite(sampleMs) || sampleMs <= 0) return previousMs ?? 0;
	if (previousMs === undefined || previousMs <= 0) return sampleMs;
	return (
		previousMs * (1 - SHAPER_CONFIG.baselineEwmaAlpha) +
		sampleMs * SHAPER_CONFIG.baselineEwmaAlpha
	);
}

function clampCap(value: number): number {
	return Math.max(
		SHAPER_CONFIG.floorBps,
		Math.min(SHAPER_CONFIG.ceilingBps, value),
	);
}
