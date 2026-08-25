import { describe, expect, test } from "bun:test";

import {
	type AimdInput,
	advanceAimd,
	SHAPER_CONFIG,
} from "../modules/network/uplink-shaper/index.ts";

const clean: AimdInput = {
	stale: false,
	rttMs: 42,
	baselineRttMs: 40,
	nakDelta: 0,
	backlogBytes: 0,
	backlogTicks: 0,
};

describe("adaptive client cap", () => {
	test("clean ticks grow additively to the ceiling clamp", () => {
		let cap = SHAPER_CONFIG.ceilingBps - SHAPER_CONFIG.additiveStepBps;
		cap = advanceAimd(cap, clean).capBps;
		cap = advanceAimd(cap, clean).capBps;
		expect(cap).toBe(SHAPER_CONFIG.ceilingBps);
	});

	test.each([
		[
			"RTT inflation",
			{
				...clean,
				rttMs: clean.baselineRttMs * SHAPER_CONFIG.rttInflationRatio,
			},
		],
		["NAK growth", { ...clean, nakDelta: 1 }],
		[
			"sustained backlog",
			{
				...clean,
				backlogBytes: SHAPER_CONFIG.backlogThresholdBytes,
				backlogTicks: SHAPER_CONFIG.backlogCongestedTicks,
			},
		],
	] as const)("%s shrinks multiplicatively", (_name, sample) => {
		expect(advanceAimd(10_000_000, sample).capBps).toBe(7_000_000);
	});

	test("stale telemetry holds the last cap", () => {
		expect(advanceAimd(7_000_000, { ...clean, stale: true }).capBps).toBe(
			7_000_000,
		);
	});

	test("repeated congestion is monotone and never starves below the floor", () => {
		const values = [SHAPER_CONFIG.bootstrapCapBps];
		for (let index = 0; index < 20; index++) {
			values.push(
				advanceAimd(values.at(-1) ?? 0, { ...clean, nakDelta: 1 }).capBps,
			);
		}
		expect(values.at(-1)).toBe(SHAPER_CONFIG.floorBps);
		expect(
			values.every(
				(value, index) => index === 0 || value <= (values[index - 1] ?? value),
			),
		).toBe(true);
	});
});
