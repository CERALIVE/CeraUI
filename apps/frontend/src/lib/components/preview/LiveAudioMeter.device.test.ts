// @vitest-environment jsdom
/**
 * LiveAudioMeter — a reading NAMES the device it is a reading of.
 *
 * The meter drew bars and nothing else, so with several cards on a board an
 * operator could not tell which one they were looking at. That is worst exactly
 * where it matters most: when the engine's own pick disagrees with theirs, these
 * bars are the only place the disagreement is visible at all — the picker above
 * happily reports the card they chose.
 *
 * Driven through the REACTIVE feed fixture for the same reason its siblings are:
 * a plain `let` behind the getter is invisible to `$derived`.
 */
import type { AudioLevelMessage, AudioSource } from "@ceraui/rpc/schemas";
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
	setAudioSources,
} from "./__fixtures__/audio-level-source.svelte";
import { AUDIO_METER_STALE_MS } from "./audio-meter-liveness";
import LiveAudioMeter from "./LiveAudioMeter.svelte";

// The board's own rows: the engine names this card `card:USB Audio` on its
// PipeWire arm, and that string is what rides `audio-level` `source.identity`.
const ROWS: AudioSource[] = [
	{
		id: "usbaudio",
		kind: "device",
		product_name: "DJI MIC MINI",
		transport: "usb",
		stable_id: "card:USB Audio",
	},
	{
		id: "hdmirx",
		kind: "device",
		label: "HDMI Input",
		stable_id: "card:fddf8000.i2s-i2s-hifi i2s-hifi-0",
	},
] as unknown as AudioSource[];

const FROM_MINI: AudioLevelMessage = {
	source: { owner: "sidecar", identity: "card:USB Audio" },
	channels: 2,
	rms_db: [-18, -19],
	peak_db: [-6, -7],
	floor_db: -1_000_000,
};

function deviceLine(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>(
		'[data-testid="live-audio-meter-device"]',
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	setAudioLevel(undefined);
	setAudioSelection("usbaudio");
	setAudioSources(ROWS);
});

afterEach(() => {
	vi.useRealTimers();
	setAudioSources([]);
});

describe("LiveAudioMeter — the metered device is named", () => {
	it("names the device a live reading belongs to", () => {
		const { container } = render(LiveAudioMeter);
		setAudioLevel(FROM_MINI);
		flushSync();

		expect(deviceLine(container)?.textContent?.trim()).toBe(
			"DJI MIC MINI · USB",
		);
	});

	it("names the card the ENGINE is metering, not the one the operator picked", () => {
		// The disagreement this exists to make visible: the operator is on the HDMI
		// input while the engine is delivering the USB mic's audio.
		setAudioSelection("hdmirx");
		const { container } = render(LiveAudioMeter);
		setAudioLevel(FROM_MINI);
		flushSync();

		expect(deviceLine(container)?.textContent?.trim()).toBe(
			"DJI MIC MINI · USB",
		);
	});

	it("says nothing for an identity the device publishes no row for", () => {
		const { container } = render(LiveAudioMeter);
		setAudioLevel({
			...FROM_MINI,
			source: { owner: "sidecar", identity: "card:never-seen" },
		});
		flushSync();

		expect(deviceLine(container)).toBeNull();
	});

	it("names nothing before the first frame, and nothing once one goes stale", () => {
		const { container } = render(LiveAudioMeter);
		flushSync();
		expect(deviceLine(container)).toBeNull();

		setAudioLevel(FROM_MINI);
		flushSync();
		expect(deviceLine(container)).not.toBeNull();

		// A retired reading has no device to name — labelling it would put a name
		// under bars that no longer describe anything.
		vi.advanceTimersByTime(AUDIO_METER_STALE_MS + 1);
		flushSync();
		expect(deviceLine(container)).toBeNull();
	});

	it("says nothing for an engine `unavailable` marker", () => {
		const { container } = render(LiveAudioMeter);
		setAudioLevel({ unavailable: true, reason: "no_device" });
		flushSync();

		expect(deviceLine(container)).toBeNull();
	});
});
