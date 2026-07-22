// @vitest-environment jsdom
import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentLevel: AudioLevelMessage | undefined;

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getAudioLevel: () => currentLevel,
}));

import LiveAudioMeter from "./LiveAudioMeter.svelte";

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

describe("LiveAudioMeter — always-visible slot + staleness watchdog (Todo 22)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		currentLevel = undefined;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders nothing before the first audio-level frame (no fake silence)", () => {
		const { container } = render(LiveAudioMeter);
		expect(meter(container)).toBeNull();
	});

	it("renders the meter live from a real level frame (not stale)", () => {
		currentLevel = {
			source: { owner: "sidecar" },
			channels: 2,
			rms_db: [-18, -19],
			peak_db: [-6, -7],
		};
		const { container } = render(LiveAudioMeter);
		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
		expect(innerMeter(container)?.getAttribute("data-unavailable")).toBe(
			"false",
		);
		expect(
			innerMeter(container)?.querySelectorAll('[data-testid="audio-channel"]'),
		).toHaveLength(2);
	});

	it("falls to unavailable (NOT frozen bars) when frames stall past the deadline", () => {
		currentLevel = { channels: 2, rms_db: [-12, -12], peak_db: [-6, -6] };
		const { container } = render(LiveAudioMeter);
		// Fresh at first.
		expect(meter(container)?.getAttribute("data-stale")).toBe("false");

		// No new frame arrives; advance past STALE_MS (2000ms). The watchdog clock
		// ticks and the meter flips to unavailable with no stale bars retained.
		vi.advanceTimersByTime(2600);
		flushSync();

		expect(meter(container)?.getAttribute("data-stale")).toBe("true");
		expect(innerMeter(container)?.getAttribute("data-unavailable")).toBe(
			"true",
		);
		expect(
			innerMeter(container)?.querySelectorAll('[data-testid="audio-channel"]'),
		).toHaveLength(0);
	});

	it("forwards an engine `unavailable` marker straight through", () => {
		currentLevel = { unavailable: true, reason: "mode_none" };
		const { container } = render(LiveAudioMeter);
		expect(innerMeter(container)?.getAttribute("data-unavailable")).toBe(
			"true",
		);
		expect(
			innerMeter(container)?.querySelector('[data-testid="audio-unavailable"]'),
		).not.toBeNull();
	});
});
