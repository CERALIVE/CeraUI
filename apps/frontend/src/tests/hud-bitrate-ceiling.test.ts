import type { ConfigMessage } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import { deriveBitrateReading, deriveHudState } from "$lib/stores/hud/derive";
import type { HudSources, HudTimestamps } from "$lib/types/hud";

// Wave H QA: a stream configured for 5 Mbps was observed carrying ~3 Mbps, and
// the HUD kept reading "5 Mbps". The engine was right — cerastream's adaptive
// controller had throttled the encoder because the link could not sustain the
// ceiling — but the HUD rendered `config.max_br`, the operator's REQUEST, as
// though it were the result. These tests pin the applied-vs-configured split and,
// just as importantly, that an engine which reports nothing is never accused of
// throttling.

const NOW = 1_000_000;

function makeTimestamps(): HudTimestamps {
	return {
		streaming: NOW,
		sensors: NOW,
		modems: NOW,
		wifi: NOW,
		connectionLostAt: null,
	};
}

function makeSources(overrides: Partial<HudSources> = {}): HudSources {
	return {
		isStreaming: true,
		isConnected: true,
		connectionState: "connected",
		config: { max_br: 5000 } as ConfigMessage,
		modems: undefined,
		wifi: undefined,
		netif: undefined,
		sensors: undefined,
		updating: false,
		...overrides,
	};
}

const hud = (overrides: Partial<HudSources> = {}) =>
	deriveHudState(makeSources(overrides), makeTimestamps(), NOW);

describe("deriveBitrateReading", () => {
	it("falls back to the configured ceiling when the engine reports nothing", () => {
		expect(deriveBitrateReading(undefined, 5000)).toEqual({
			effectiveKbps: 5000,
			belowCeiling: false,
		});
		expect(deriveBitrateReading(null, 5000)).toEqual({
			effectiveKbps: 5000,
			belowCeiling: false,
		});
	});

	it("reports the APPLIED rate and flags the gap when the engine throttled down", () => {
		expect(
			deriveBitrateReading({ applied_kbps: 3000, ceiling_kbps: 5000 }, 5000),
		).toEqual({ effectiveKbps: 3000, belowCeiling: true });
	});

	it("does not flag a stream running AT its ceiling", () => {
		expect(
			deriveBitrateReading({ applied_kbps: 5000, ceiling_kbps: 5000 }, 5000),
		).toEqual({ effectiveKbps: 5000, belowCeiling: false });
	});

	it("trusts the ENGINE's ceiling over a config the engine has not adopted yet", () => {
		// The operator just raised the ceiling to 8000; the engine is still running
		// the 5000 it was started with, at 5000. That is not throttling.
		expect(
			deriveBitrateReading({ applied_kbps: 5000, ceiling_kbps: 5000 }, 8000),
		).toEqual({ effectiveKbps: 5000, belowCeiling: false });
	});

	it("still reports the applied rate when no ceiling is known at all", () => {
		expect(
			deriveBitrateReading({ applied_kbps: 3000, ceiling_kbps: 0 }, null),
		).toEqual({ effectiveKbps: 3000, belowCeiling: false });
	});
});

describe("deriveHudState — bitrate honesty", () => {
	it("is byte-identical to the pre-engine_bitrate behaviour when absent", () => {
		const state = hud();
		expect(state.bitrateKbps).toBe(5000);
		expect(state.bitrateCeilingKbps).toBe(5000);
		expect(state.isBitrateBelowCeiling).toBe(false);
	});

	it("surfaces the throttled rate beside the ceiling the operator configured", () => {
		const state = hud({
			engineBitrate: { applied_kbps: 3000, ceiling_kbps: 5000 },
		});
		expect(state.bitrateKbps).toBe(3000);
		expect(state.bitrateCeilingKbps).toBe(5000);
		expect(state.isBitrateBelowCeiling).toBe(true);
	});

	it("never claims throttling while idle — every bitrate fact clears on stop", () => {
		const state = hud({
			isStreaming: false,
			engineBitrate: { applied_kbps: 3000, ceiling_kbps: 5000 },
		});
		expect(state.bitrateKbps).toBeNull();
		expect(state.bitrateCeilingKbps).toBeNull();
		expect(state.isBitrateBelowCeiling).toBe(false);
	});

	it("reports no bitrate at all when neither engine nor config supply one", () => {
		const state = hud({ config: undefined });
		expect(state.bitrateKbps).toBeNull();
		expect(state.isBitrateBelowCeiling).toBe(false);
	});
});
