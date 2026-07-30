import type { ConfigMessage, LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import {
	deriveHudState,
	deriveMeasuredBitrateKbps,
} from "$lib/stores/hud/derive";
import type { HudSources, HudTimestamps } from "$lib/types/hud";

// The live "bitrate" every surface rendered was `engine_bitrate.applied_kbps` —
// the adaptive controller's own SETPOINT. Proven on a board: a steady 4100 kbps
// held for a whole 30 s session while cerastream's watchdog logged
// "frames-not-advancing" and /proc/net/dev showed only SSH/WS traffic. The
// readout could not tell "streaming at 4.1 Mbps" from "streaming nothing".
//
// srtla_send has always measured the real thing (ADR-001 `bitrate_bps`, wire
// bytes × 8) and CeraUI discarded it. These tests pin the measured figure, and
// pin just as hard that an UNKNOWN is never rendered as a number.

const NOW = 1_000_000;

function link(overrides: Partial<LinkTelemetryMessage["links"][number]> = {}) {
	return {
		conn_id: "0",
		iface: "usb0",
		rtt_ms: 20,
		nak_count: 0,
		weight_percent: 100,
		bitrate_bps: 0,
		stale: false,
		...overrides,
	};
}

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
		config: { max_br: 4500 } as ConfigMessage,
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

describe("deriveMeasuredBitrateKbps", () => {
	it("converts the bond's summed wire bitrate to kbps", () => {
		expect(
			deriveMeasuredBitrateKbps({
				links: [link(), link({ conn_id: "1", iface: "wlan0" })],
				measured_bps: 3_500_000,
			}),
		).toBe(3500);
	});

	it("reports a bond carrying NOTHING as zero — the setpoint's blind spot", () => {
		expect(
			deriveMeasuredBitrateKbps({ links: [link()], measured_bps: 0 }),
		).toBe(0);
	});

	it("is unknown, not zero, when no telemetry has arrived or the stream stopped", () => {
		// Tri-state upstream: `undefined` pre-first-status, `null` stopped.
		expect(deriveMeasuredBitrateKbps(undefined)).toBeNull();
		expect(deriveMeasuredBitrateKbps(null)).toBeNull();
	});

	it("is unknown when the sender publishes no aggregate at all", () => {
		expect(deriveMeasuredBitrateKbps({ links: [link()] })).toBeNull();
	});

	it("refuses a snapshot whose every link is stale — frozen counters lie", () => {
		expect(
			deriveMeasuredBitrateKbps({
				links: [link({ stale: true }), link({ conn_id: "1", stale: true })],
				measured_bps: 3_500_000,
			}),
		).toBeNull();
	});

	it("still reports when only SOME links are stale", () => {
		expect(
			deriveMeasuredBitrateKbps({
				links: [link({ stale: true }), link({ conn_id: "1", stale: false })],
				measured_bps: 2_000_000,
			}),
		).toBe(2000);
	});

	it("refuses a malformed aggregate rather than rendering NaN", () => {
		expect(
			deriveMeasuredBitrateKbps({
				links: [link()],
				measured_bps: Number.NaN,
			}),
		).toBeNull();
	});
});

describe("deriveHudState — measured beside the target", () => {
	it("carries the measurement and the setpoint as two separate facts", () => {
		const state = hud({
			engineBitrate: { applied_kbps: 4100, ceiling_kbps: 4500 },
			linkTelemetry: { links: [link()], measured_bps: 3_200_000 },
		});

		expect(state.measuredBitrateKbps).toBe(3200);
		expect(state.bitrateKbps).toBe(4100);
	});

	it("reproduces the board fixture: setpoint 4100, measured ZERO", () => {
		const state = hud({
			engineBitrate: { applied_kbps: 4100, ceiling_kbps: 4500 },
			linkTelemetry: { links: [link()], measured_bps: 0 },
		});

		expect(state.measuredBitrateKbps).toBe(0);
		expect(state.bitrateKbps).toBe(4100);
	});

	it("leaves the measurement unknown when srtla telemetry is absent", () => {
		const state = hud({
			engineBitrate: { applied_kbps: 4100, ceiling_kbps: 4500 },
		});

		expect(state.measuredBitrateKbps).toBeNull();
		expect(state.bitrateKbps).toBe(4100);
	});

	it("clears the measurement on stop, like every other live-data fact", () => {
		const state = hud({
			isStreaming: false,
			engineBitrate: { applied_kbps: 4100, ceiling_kbps: 4500 },
			linkTelemetry: { links: [link()], measured_bps: 3_200_000 },
		});

		expect(state.measuredBitrateKbps).toBeNull();
		expect(state.bitrateKbps).toBeNull();
	});
});
