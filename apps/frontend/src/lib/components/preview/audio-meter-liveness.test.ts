/**
 * Audio-meter liveness rule — the pure half.
 *
 * Locks the content-vs-arrival distinction that the frozen-meter bug turned on:
 * a frame is only evidence of life when it says something NEW.
 */
import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	AUDIO_METER_FLOOR_DB,
	AUDIO_METER_STALE_MS,
	INITIAL_METER_FRESHNESS,
	INITIAL_METER_SELECTION_GATE,
	isDigitalSilence,
	isLevelSuperseded,
	isMeterStale,
	meterFingerprint,
	trackMeterFreshness,
	trackMeterSelection,
} from "./audio-meter-liveness";

/**
 * The exact payload a Rock 5B+ produced, byte for byte, 226 frames out of 226
 * over 45 s: a RØDE HDMI-to-USB-C with no source on its HDMI input, still
 * clocking ALSA buffers of frozen content.
 */
const FROZEN: AudioLevelMessage = {
	source: { owner: "sidecar", identity: "card:usbaudio" },
	channels: 2,
	rms_db: [-41.522344822589105, -44.116395350676385],
	peak_db: [-41.522344822589105, -44.116395350676385],
	floor_db: -1_000_000,
};

/** A distinct object with identical content — what each 5 Hz broadcast really is. */
function reemit(level: AudioLevelMessage): AudioLevelMessage {
	return structuredClone(level);
}

/**
 * A realistic wall-clock origin. Never start a case at `0`: that is the
 * `lastChangedAt` sentinel for "no frame has ever landed", so a real reading
 * stamped at 0 would be indistinguishable from the pending state.
 */
const T0 = 1_700_000_000_000;

describe("isDigitalSilence", () => {
	it("treats an at-or-below-floor reading as silence", () => {
		expect(
			isDigitalSilence({
				channels: 2,
				rms_db: [-1e6, -1e6],
				peak_db: [-1e6, -1e6],
			}),
		).toBe(true);
		expect(
			isDigitalSilence({
				channels: 1,
				rms_db: [AUDIO_METER_FLOOR_DB],
				peak_db: [AUDIO_METER_FLOOR_DB],
			}),
		).toBe(true);
	});

	it("does not call an audible reading silence", () => {
		expect(isDigitalSilence(FROZEN)).toBe(false);
		expect(
			isDigitalSilence({
				channels: 2,
				rms_db: [-1e6, -1e6],
				peak_db: [-1e6, -59],
			}),
		).toBe(false);
	});

	it("treats a frame with no channel data at all as silence", () => {
		expect(isDigitalSilence({})).toBe(true);
		expect(isDigitalSilence({ channels: 0, rms_db: [], peak_db: [] })).toBe(
			true,
		);
	});
});

describe("meterFingerprint", () => {
	it("is identical for two re-emissions of the same reading", () => {
		expect(meterFingerprint(reemit(FROZEN))).toBe(meterFingerprint(FROZEN));
	});

	it("changes when any rendered value changes", () => {
		expect(
			meterFingerprint({
				...FROZEN,
				rms_db: [-41.52234482258911, -44.116395350676385],
			}),
		).not.toBe(meterFingerprint(FROZEN));
		expect(
			meterFingerprint({ ...FROZEN, peak_db: [-12, -44.116395350676385] }),
		).not.toBe(meterFingerprint(FROZEN));
	});

	it("changes on a sidecar → streaming handoff even at identical numbers", () => {
		expect(
			meterFingerprint({
				...FROZEN,
				source: { owner: "streaming", identity: "card:usbaudio" },
			}),
		).not.toBe(meterFingerprint(FROZEN));
	});

	it("changes when the metered card changes", () => {
		expect(
			meterFingerprint({
				...FROZEN,
				source: { owner: "sidecar", identity: "card:dji" },
			}),
		).not.toBe(meterFingerprint(FROZEN));
	});
});

describe("trackMeterFreshness — the clock advances on CONTENT, not arrival", () => {
	it("stamps the first frame", () => {
		const next = trackMeterFreshness(INITIAL_METER_FRESHNESS, FROZEN, 1_000);
		expect(next.lastChangedAt).toBe(1_000);
	});

	it("does NOT restamp on a re-emission of the same reading", () => {
		const first = trackMeterFreshness(INITIAL_METER_FRESHNESS, FROZEN, 1_000);
		const second = trackMeterFreshness(first, reemit(FROZEN), 1_200);
		expect(second.lastChangedAt).toBe(1_000);
		// Identity is preserved so a runes assignment is a no-op.
		expect(second).toBe(first);
	});

	it("goes stale after a run of identical re-emissions at the engine cadence", () => {
		let freshness = trackMeterFreshness(INITIAL_METER_FRESHNESS, FROZEN, T0);
		let now = T0;
		// 5 Hz for 4 s — 20 fresh envelopes, one unchanging reading.
		for (let i = 0; i < 20; i += 1) {
			now += 200;
			freshness = trackMeterFreshness(freshness, reemit(FROZEN), now);
		}
		expect(freshness.lastChangedAt).toBe(T0);
		expect(isMeterStale(freshness, now)).toBe(true);
	});

	it("keeps a genuinely moving signal live indefinitely", () => {
		let freshness = trackMeterFreshness(INITIAL_METER_FRESHNESS, FROZEN, T0);
		let now = T0;
		for (let i = 0; i < 50; i += 1) {
			now += 200;
			freshness = trackMeterFreshness(
				freshness,
				{
					...FROZEN,
					rms_db: [-40 - i * 0.1, -44],
					peak_db: [-30 - i * 0.1, -40],
				},
				now,
			);
		}
		expect(isMeterStale(freshness, now)).toBe(false);
	});

	it("recovers the instant the reading changes again", () => {
		let freshness = trackMeterFreshness(INITIAL_METER_FRESHNESS, FROZEN, T0);
		freshness = trackMeterFreshness(freshness, reemit(FROZEN), T0 + 5_000);
		expect(isMeterStale(freshness, T0 + 5_000)).toBe(true);

		freshness = trackMeterFreshness(
			freshness,
			{ ...FROZEN, rms_db: [-12, -13] },
			T0 + 5_200,
		);
		expect(isMeterStale(freshness, T0 + 5_200)).toBe(false);
	});

	it("never ages out repeated digital silence — a muted mic is a WORKING meter", () => {
		const silence: AudioLevelMessage = {
			source: { owner: "sidecar", identity: "card:usbaudio" },
			channels: 2,
			rms_db: [-1e6, -1e6],
			peak_db: [-1e6, -1e6],
		};
		let freshness = trackMeterFreshness(INITIAL_METER_FRESHNESS, silence, 0);
		let now = 0;
		for (let i = 0; i < 50; i += 1) {
			now += 200;
			freshness = trackMeterFreshness(freshness, reemit(silence), now);
		}
		expect(isMeterStale(freshness, now)).toBe(false);
	});

	it("never ages out a repeated engine `unavailable` marker (it keeps its reason)", () => {
		const gap: AudioLevelMessage = { unavailable: true, reason: "no_device" };
		let freshness = trackMeterFreshness(INITIAL_METER_FRESHNESS, gap, 0);
		let now = 0;
		for (let i = 0; i < 20; i += 1) {
			now += 200;
			freshness = trackMeterFreshness(freshness, reemit(gap), now);
		}
		expect(isMeterStale(freshness, now)).toBe(false);
	});

	it("lets a stopped feed age out — no frame means no call, so the clock stops", () => {
		const freshness = trackMeterFreshness(
			INITIAL_METER_FRESHNESS,
			FROZEN,
			1_000,
		);
		expect(isMeterStale(freshness, 1_000 + AUDIO_METER_STALE_MS)).toBe(false);
		expect(isMeterStale(freshness, 1_000 + AUDIO_METER_STALE_MS + 1)).toBe(
			true,
		);
	});

	it("ignores an absent frame rather than resetting the clock", () => {
		const first = trackMeterFreshness(INITIAL_METER_FRESHNESS, FROZEN, 1_000);
		expect(trackMeterFreshness(first, undefined, 9_000)).toBe(first);
	});

	it("is not stale before any frame has ever landed", () => {
		expect(isMeterStale(INITIAL_METER_FRESHNESS, 10_000_000)).toBe(false);
	});
});

/**
 * Wave H board bug: switching the audio source to "No audio" left the previous
 * device's bars on screen for seconds. The level standing at the moment of the
 * switch was measured for a pick the operator has already abandoned, and nothing
 * replaces it until the next broadcast.
 */
describe("trackMeterSelection — a reading belongs to the pick that produced it", () => {
	const LEVEL_A: AudioLevelMessage = {
		source: { owner: "sidecar", identity: "card:usbaudio" },
		channels: 2,
		rms_db: [-18, -19],
		peak_db: [-6, -7],
	};
	const LEVEL_B: AudioLevelMessage = { ...LEVEL_A, rms_db: [-30, -31] };

	it("never supersedes the first frame it ever sees", () => {
		const gate = trackMeterSelection(
			INITIAL_METER_SELECTION_GATE,
			"RODE",
			LEVEL_A,
		);
		expect(isLevelSuperseded(gate, LEVEL_A)).toBe(false);
	});

	it("retires the standing reading the moment the pick changes", () => {
		let gate = trackMeterSelection(
			INITIAL_METER_SELECTION_GATE,
			"RODE",
			LEVEL_A,
		);
		gate = trackMeterSelection(gate, "No audio", LEVEL_A);
		expect(isLevelSuperseded(gate, LEVEL_A)).toBe(true);
	});

	it("releases on the very next frame — a re-evaluated pick is not muted", () => {
		let gate = trackMeterSelection(
			INITIAL_METER_SELECTION_GATE,
			"RODE",
			LEVEL_A,
		);
		gate = trackMeterSelection(gate, "MINI", LEVEL_A);
		gate = trackMeterSelection(gate, "MINI", LEVEL_B);
		expect(isLevelSuperseded(gate, LEVEL_B)).toBe(false);
	});

	it("holds the gate for as long as the same object keeps being read", () => {
		let gate = trackMeterSelection(
			INITIAL_METER_SELECTION_GATE,
			"RODE",
			LEVEL_A,
		);
		gate = trackMeterSelection(gate, "MINI", LEVEL_A);
		for (let i = 0; i < 5; i += 1) {
			gate = trackMeterSelection(gate, "MINI", LEVEL_A);
		}
		expect(isLevelSuperseded(gate, LEVEL_A)).toBe(true);
	});

	it("keys on the FRAME, so an equal-content replacement still renders", () => {
		let gate = trackMeterSelection(
			INITIAL_METER_SELECTION_GATE,
			"RODE",
			LEVEL_A,
		);
		gate = trackMeterSelection(gate, "MINI", LEVEL_A);
		const replay = { ...LEVEL_A };
		gate = trackMeterSelection(gate, "MINI", replay);
		expect(isLevelSuperseded(gate, replay)).toBe(false);
	});

	it("is a no-op while the pick is unchanged", () => {
		const first = trackMeterSelection(
			INITIAL_METER_SELECTION_GATE,
			"RODE",
			LEVEL_A,
		);
		expect(trackMeterSelection(first, "RODE", LEVEL_A)).toBe(first);
	});

	it("distinguishes an unset pick from a pick not yet observed", () => {
		let gate = trackMeterSelection(
			INITIAL_METER_SELECTION_GATE,
			undefined,
			LEVEL_A,
		);
		expect(isLevelSuperseded(gate, LEVEL_A)).toBe(false);
		gate = trackMeterSelection(gate, "RODE", LEVEL_A);
		expect(isLevelSuperseded(gate, LEVEL_A)).toBe(true);
	});

	it("supersedes nothing when there was no reading to retire", () => {
		let gate = trackMeterSelection(
			INITIAL_METER_SELECTION_GATE,
			"RODE",
			undefined,
		);
		gate = trackMeterSelection(gate, "No audio", undefined);
		expect(isLevelSuperseded(gate, undefined)).toBe(false);
	});
});
