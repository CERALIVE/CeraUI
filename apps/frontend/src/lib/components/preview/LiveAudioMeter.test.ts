// @vitest-environment jsdom
import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentLevel: AudioLevelMessage | undefined;

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getAudioLevel: () => currentLevel,
	getConfig: () => undefined,
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

describe("LiveAudioMeter — always-mounted inline meter + staleness watchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		currentLevel = undefined;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stays mounted and shows `unavailable` before the first frame (never vanishes)", () => {
		const { container } = render(LiveAudioMeter);

		// The outer wrapper NEVER unmounts — the inner meter's own unavailable
		// state is what an operator sees, not a blank gap where the meter was.
		expect(meter(container)).not.toBeNull();
		expect(meter(container)?.getAttribute("data-pending")).toBe("true");
		expect(innerMeter(container)?.getAttribute("data-unavailable")).toBe(
			"true",
		);
		expect(
			innerMeter(container)?.querySelector('[data-testid="audio-unavailable"]'),
		).not.toBeNull();
	});

	it("renders no fake silence before the first frame (no channel bars)", () => {
		const { container } = render(LiveAudioMeter);
		expect(
			innerMeter(container)?.querySelectorAll('[data-testid="audio-channel"]'),
		).toHaveLength(0);
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
		expect(meter(container)?.getAttribute("data-pending")).toBe("false");
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
