// @vitest-environment jsdom
/**
 * LiveAudioMeter — no level survives the audio-source switch that invalidated it.
 *
 * Wave H board QA: with "Audio source: No audio" selected, two green level bars
 * rendered mid-fill for several seconds before the meter settled. Those bars
 * were REAL audio from the card the engine auto-picked (a `null` meter
 * preference means "engine, choose for yourself"), and the frame drawing them
 * had been measured for the pick the operator had just moved away from.
 *
 * The backend now publishes the gap the instant the pick changes; this file
 * covers the frontend half, which must not keep drawing the old reading while
 * that broadcast is in flight. Driven through the REACTIVE feed fixture for the
 * same reason `LiveAudioMeter.frozen.test.ts` is: a plain `let` behind the
 * getter is invisible to `$derived`, so the component would see one frame and
 * the assertions would pass without exercising anything.
 */
import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"$lib/rpc/subscriptions.svelte",
	async () => await import("./__fixtures__/audio-level-source.svelte"),
);

import {
	setAudioLevel,
	setAudioSelection,
} from "./__fixtures__/audio-level-source.svelte";
import { AUDIO_METER_STALE_MS } from "./audio-meter-liveness";
import LiveAudioMeter from "./LiveAudioMeter.svelte";

const FROM_RODE: AudioLevelMessage = {
	source: { owner: "sidecar", identity: "card:usbaudio" },
	channels: 2,
	rms_db: [-18, -19],
	peak_db: [-6, -7],
	floor_db: -1_000_000,
};

function meter(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>(
		'[data-testid="live-audio-meter"]',
	);
}
function innerMeter(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>(
		'[data-testid="audio-level-meter"]',
	);
}
function channelBars(container: HTMLElement): NodeListOf<Element> | undefined {
	return innerMeter(container)?.querySelectorAll(
		'[data-testid="audio-channel"]',
	);
}

function mountedOn(selection: string): { container: HTMLElement } {
	setAudioSelection(selection);
	setAudioLevel(structuredClone(FROM_RODE));
	const rendered = render(LiveAudioMeter);
	flushSync();
	return rendered;
}

describe("LiveAudioMeter — a level belongs to the pick that produced it", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setAudioLevel(undefined);
		setAudioSelection(undefined);
	});
	afterEach(() => {
		vi.useRealTimers();
		setAudioLevel(undefined);
		setAudioSelection(undefined);
	});

	it("draws no bars the instant the operator picks `No audio`", () => {
		const { container } = mountedOn("RODE HDMI to USB-C");
		expect(channelBars(container)).toHaveLength(2);

		setAudioSelection("No audio");
		flushSync();

		expect(meter(container)?.getAttribute("data-superseded")).toBe("true");
		expect(innerMeter(container)?.getAttribute("data-unavailable")).toBe(
			"true",
		);
		expect(channelBars(container)).toHaveLength(0);
	});

	it("clears without waiting for the backend's confirming broadcast", () => {
		const { container } = mountedOn("RODE HDMI to USB-C");

		setAudioSelection("No audio");
		flushSync();
		// Deliberately INSIDE the staleness deadline: the frozen-content watchdog
		// is what made this bug read as "a few seconds of bars, then it settles",
		// so a test that waits for it would prove nothing about the switch itself.
		vi.advanceTimersByTime(AUDIO_METER_STALE_MS - 500);
		flushSync();

		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
		expect(channelBars(container)).toHaveLength(0);
	});

	it("keeps no trace of the old pick on a device-to-device switch", () => {
		const { container } = mountedOn("RODE HDMI to USB-C");

		setAudioSelection("DJI MIC MINI");
		flushSync();

		expect(channelBars(container)).toHaveLength(0);
	});

	it("shows the new device as soon as its first real level lands", () => {
		const { container } = mountedOn("RODE HDMI to USB-C");

		setAudioSelection("DJI MIC MINI");
		flushSync();
		expect(channelBars(container)).toHaveLength(0);

		setAudioLevel({
			source: { owner: "sidecar", identity: "card:MINI" },
			channels: 2,
			rms_db: [-24, -25],
			peak_db: [-12, -13],
			floor_db: -1_000_000,
		});
		flushSync();

		expect(meter(container)?.getAttribute("data-superseded")).toBe("false");
		expect(channelBars(container)).toHaveLength(2);
	});

	it("drops the stale frame's reason too, never relabelling it", () => {
		setAudioSelection("HDMI Input");
		setAudioLevel({ unavailable: true, reason: "not_selected_device" });
		const { container } = render(LiveAudioMeter);
		flushSync();
		expect(
			innerMeter(container)?.querySelector('[data-testid="audio-unavailable"]')
				?.textContent,
		).toContain("Not the selected device");

		setAudioSelection("No audio");
		flushSync();

		expect(
			innerMeter(container)?.querySelector('[data-testid="audio-unavailable"]')
				?.textContent,
		).not.toContain("Not the selected device");
	});

	it("leaves a steady pick's live meter completely alone", () => {
		const { container } = mountedOn("RODE HDMI to USB-C");

		for (let i = 0; i < 10; i += 1) {
			vi.advanceTimersByTime(200);
			setAudioLevel({
				...FROM_RODE,
				rms_db: [-18 - (i % 5), -19 - (i % 3)],
				peak_db: [-6 - (i % 5), -7 - (i % 3)],
			});
			flushSync();
		}

		expect(meter(container)?.getAttribute("data-superseded")).toBe("false");
		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
		expect(channelBars(container)).toHaveLength(2);
	});
});
