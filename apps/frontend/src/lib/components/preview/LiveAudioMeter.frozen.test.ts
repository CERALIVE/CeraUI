// @vitest-environment jsdom
/**
 * LiveAudioMeter — the frozen-meter regression, driven through a REACTIVE feed.
 *
 * `LiveAudioMeter.test.ts` covers the always-mounted/pending/stall/unavailable
 * contract against a static level. It cannot cover this bug: its mock getter
 * reads a plain `let`, which `$derived` does not track, so the component sees
 * exactly one frame per test. The defect here is frames that KEEP ARRIVING while
 * their content never changes, so the feed has to be genuinely reactive —
 * otherwise the meter would go stale for the "the feed stopped" reason and the
 * assertion would pass while proving nothing.
 *
 * Reproduces the Rock 5B+ finding byte for byte: a RØDE HDMI-to-USB-C with no
 * source on its HDMI input kept its ALSA capture substream RUNNING and its
 * `hw_ptr` advancing, so cerastream truthfully published an unchanging
 * `rms_db:[-41.522344822589105,-44.116395350676385]` at 5 Hz — 226 identical
 * frames out of 226 over 45 s. At a −60 dBFS floor that draws a 31 % bar that
 * never moves.
 */
import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"$lib/rpc/subscriptions.svelte",
	async () => await import("./__fixtures__/audio-level-source.svelte"),
);

import { setAudioLevel } from "./__fixtures__/audio-level-source.svelte";
import LiveAudioMeter from "./LiveAudioMeter.svelte";

const FROZEN: AudioLevelMessage = {
	source: { owner: "sidecar", identity: "card:usbaudio" },
	channels: 2,
	rms_db: [-41.522344822589105, -44.116395350676385],
	peak_db: [-41.522344822589105, -44.116395350676385],
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

/**
 * Deliver `count` frames at the engine's real 5 Hz cadence. Each is a DISTINCT
 * object (a fresh broadcast), exactly like `subscriptions.svelte`'s handler.
 */
function pump(count: number, build: (i: number) => AudioLevelMessage): void {
	for (let i = 0; i < count; i += 1) {
		vi.advanceTimersByTime(200);
		setAudioLevel(structuredClone(build(i)));
		flushSync();
	}
}

describe("LiveAudioMeter — a frozen feed is a DEAD feed", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setAudioLevel(undefined);
	});
	afterEach(() => {
		vi.useRealTimers();
		setAudioLevel(undefined);
	});

	it("falls to unavailable when the backend keeps re-emitting the SAME level", () => {
		setAudioLevel(structuredClone(FROZEN));
		const { container } = render(LiveAudioMeter);
		flushSync();

		// Live at first — one real reading is a real reading.
		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
		expect(channelBars(container)).toHaveLength(2);

		// 4 s of unchanging frames at the engine cadence.
		pump(20, () => FROZEN);

		expect(meter(container)?.getAttribute("data-stale")).toBe("true");
		expect(innerMeter(container)?.getAttribute("data-unavailable")).toBe(
			"true",
		);
		// The whole point: NO frozen bars retained.
		expect(channelBars(container)).toHaveLength(0);
	});

	it("crosses over within the documented 2 s deadline, not later", () => {
		setAudioLevel(structuredClone(FROZEN));
		const { container } = render(LiveAudioMeter);
		flushSync();

		pump(9, () => FROZEN); // 1.8 s — still inside the window
		expect(meter(container)?.getAttribute("data-stale")).toBe("false");

		pump(4, () => FROZEN); // 2.6 s total — past it
		expect(meter(container)?.getAttribute("data-stale")).toBe("true");
	});

	it("keeps a genuinely moving signal live for as long as it moves", () => {
		setAudioLevel(structuredClone(FROZEN));
		const { container } = render(LiveAudioMeter);
		flushSync();

		// 10 s of real, changing audio.
		pump(50, (i) => ({
			...FROZEN,
			rms_db: [-40 - (i % 7), -44 - (i % 5)],
			peak_db: [-30 - (i % 7), -34 - (i % 5)],
		}));

		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
		expect(innerMeter(container)?.getAttribute("data-unavailable")).toBe(
			"false",
		);
		expect(channelBars(container)).toHaveLength(2);
	});

	it("recovers the moment the signal moves again", () => {
		setAudioLevel(structuredClone(FROZEN));
		const { container } = render(LiveAudioMeter);
		flushSync();

		pump(20, () => FROZEN);
		expect(meter(container)?.getAttribute("data-stale")).toBe("true");

		pump(1, () => ({ ...FROZEN, rms_db: [-12, -13], peak_db: [-6, -7] }));
		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
		expect(channelBars(container)).toHaveLength(2);
	});

	it("leaves repeated digital silence as `silent` — a muted mic is a WORKING meter", () => {
		const silence: AudioLevelMessage = {
			source: { owner: "sidecar", identity: "card:usbaudio" },
			channels: 2,
			rms_db: [-1e6, -1e6],
			peak_db: [-1e6, -1e6],
		};
		setAudioLevel(structuredClone(silence));
		const { container } = render(LiveAudioMeter);
		flushSync();

		pump(50, () => silence);

		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
		expect(innerMeter(container)?.getAttribute("data-unavailable")).toBe(
			"false",
		);
		expect(
			innerMeter(container)?.querySelector('[data-testid="audio-silent"]'),
		).not.toBeNull();
	});

	it("keeps the engine reason on a repeated `unavailable` marker", () => {
		const gap: AudioLevelMessage = { unavailable: true, reason: "no_device" };
		setAudioLevel(structuredClone(gap));
		const { container } = render(LiveAudioMeter);
		flushSync();

		pump(20, () => gap);

		// Still unavailable, but via the engine's own marker (which carries a
		// reason) rather than being aged out into a reasonless stale render.
		expect(innerMeter(container)?.getAttribute("data-unavailable")).toBe(
			"true",
		);
		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
	});

	it("still ages out a feed that stops entirely", () => {
		setAudioLevel(structuredClone(FROZEN));
		const { container } = render(LiveAudioMeter);
		flushSync();

		vi.advanceTimersByTime(2_600);
		flushSync();

		expect(meter(container)?.getAttribute("data-stale")).toBe("true");
		expect(channelBars(container)).toHaveLength(0);
	});

	it("does not restamp on the engine replaying its cached level to a reconnecting subscriber", () => {
		// cerastream hydrates a NEW audio-level subscriber with its cached last
		// observation, and the idle sidecar has no delivery deadline — so a stalled
		// sidecar's stale level is replayed on every bridge reconnect. Arrival
		// stamping reset the watchdog each time; content stamping must not.
		setAudioLevel(structuredClone(FROZEN));
		const { container } = render(LiveAudioMeter);
		flushSync();

		vi.advanceTimersByTime(2_600);
		flushSync();
		expect(meter(container)?.getAttribute("data-stale")).toBe("true");

		// Reconnect → hydration replay of the very same cached observation.
		setAudioLevel(structuredClone(FROZEN));
		flushSync();

		expect(meter(container)?.getAttribute("data-stale")).toBe("true");
		expect(channelBars(container)).toHaveLength(0);
	});
});
