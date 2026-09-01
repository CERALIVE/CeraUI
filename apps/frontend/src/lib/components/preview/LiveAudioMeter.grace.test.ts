// @vitest-environment jsdom
/**
 * LiveAudioMeter — a transient gap between two live readings must not FLASH a band.
 *
 * The meter's `unavailable` render is honest and it is also instantaneous, so a
 * single dropped frame between two healthy readings drew a full "Meter
 * unavailable" band for one paint and then took it away again. On a board that
 * reads as the meter blinking, and an operator cannot tell a blink apart from
 * the real thing — which is exactly the signal the band exists to carry.
 *
 * This file covers the DISPLAY grace only. The mechanism that generates those
 * gaps in the first place is the engine's, and is fixed engine-side; nothing
 * here changes `pending`, `stale` or `superseded`, and two of the six typed
 * reasons are deliberately exempt (see the last describe).
 *
 * Driven through the REACTIVE feed fixture for the same reason
 * `LiveAudioMeter.frozen.test.ts` is: a plain `let` behind the getter is
 * invisible to `$derived`, so the component would see exactly one frame and
 * every sequence below would prove nothing.
 */
import type {
	AudioLevelMessage,
	AudioLevelUnavailableReason,
} from "@ceraui/rpc/schemas";
import { AUDIO_LEVEL_UNAVAILABLE_REASONS } from "@ceraui/rpc/schemas";
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
import {
	AUDIO_METER_STALE_MS,
	isTransientMeterGap,
	METER_UNAVAILABLE_DISPLAY_GRACE_MS,
	STATED_UNAVAILABLE_REASONS,
} from "./audio-meter-liveness";
import LiveAudioMeter from "./LiveAudioMeter.svelte";

/** A real, moving reading. Every emission is a distinct object, like the broadcast. */
function live(i: number): AudioLevelMessage {
	return {
		source: { owner: "sidecar", identity: "card:usbaudio" },
		channels: 2,
		rms_db: [-18 - (i % 5), -19 - (i % 3)],
		peak_db: [-6 - (i % 5), -7 - (i % 3)],
		floor_db: -1_000_000,
	};
}

/** The gap the engine publishes across a handoff — the graceable class. */
function gap(
	reason: AudioLevelMessage["reason"] = "handoff",
): AudioLevelMessage {
	return { unavailable: true, reason };
}

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
function bars(container: HTMLElement): number {
	return (
		innerMeter(container)?.querySelectorAll('[data-testid="audio-channel"]')
			.length ?? 0
	);
}
function bandText(container: HTMLElement): string | null {
	return (
		innerMeter(container)
			?.querySelector('[data-testid="audio-unavailable"]')
			?.textContent?.trim() ?? null
	);
}
function bandShown(container: HTMLElement): boolean {
	return innerMeter(container)?.getAttribute("data-unavailable") === "true";
}

/** Deliver one frame at the engine's real 5 Hz cadence. */
function emit(level: AudioLevelMessage): void {
	vi.advanceTimersByTime(200);
	setAudioLevel(structuredClone(level));
	flushSync();
}

/** Mount with a live reading already on screen — the state a gap interrupts. */
function mountedLive(): { container: HTMLElement } {
	setAudioLevel(structuredClone(live(0)));
	const rendered = render(LiveAudioMeter);
	flushSync();
	return rendered;
}

beforeEach(() => {
	vi.useFakeTimers();
	setAudioLevel(undefined);
	setAudioSelection("usbaudio");
});
afterEach(() => {
	vi.useRealTimers();
	setAudioLevel(undefined);
	setAudioSelection(undefined);
});

describe("LiveAudioMeter — the grace window is the documented one", () => {
	it("is exactly 1200 ms", () => {
		// A later docs todo and CeraUI's own AGENTS.md grep for this exact name,
		// and the value is the reviewed one — not a knob to tune in place.
		expect(METER_UNAVAILABLE_DISPLAY_GRACE_MS).toBe(1_200);
	});

	it("sits strictly inside the staleness deadline", () => {
		// A grace at or past AUDIO_METER_STALE_MS would be unreachable: the
		// staleness watchdog would have drawn its own band first, every time.
		expect(METER_UNAVAILABLE_DISPLAY_GRACE_MS).toBeLessThan(
			AUDIO_METER_STALE_MS,
		);
	});
});

describe("isTransientMeterGap — the exemption table, derived from the wire enum", () => {
	// DERIVED from `AUDIO_LEVEL_UNAVAILABLE_REASONS` rather than re-typed, so a
	// seventh reason fails this gate until somebody decides which side of the
	// grace it belongs on. Silently graced is the wrong default: a new reason is
	// most likely to be a stated one, and delaying a stated fact is the
	// regression this whole exemption exists to prevent.
	const GRACED: readonly AudioLevelUnavailableReason[] = [
		"device_busy",
		"no_device",
		"not_selected_device",
		"handoff",
	];
	const STATED: readonly AudioLevelUnavailableReason[] = [
		"mode_none",
		"embedded_audio",
	];

	it("classifies every reason the wire can carry, and no more", () => {
		expect([...GRACED, ...STATED].sort()).toEqual(
			[...AUDIO_LEVEL_UNAVAILABLE_REASONS].sort(),
		);
		expect(STATED_UNAVAILABLE_REASONS).toEqual(new Set(STATED));
	});

	it.each(GRACED)("holds a transient `%s` gap", (reason) => {
		expect(isTransientMeterGap({ unavailable: true, reason })).toBe(true);
	});

	it.each(STATED)("never holds a stated `%s` gap", (reason) => {
		expect(isTransientMeterGap({ unavailable: true, reason })).toBe(false);
	});

	it("holds an unnamed gap — the weakest claim on the wire", () => {
		expect(isTransientMeterGap({ unavailable: true })).toBe(true);
	});

	it("answers false for a real reading and for no reading at all", () => {
		expect(isTransientMeterGap(live(0))).toBe(false);
		expect(isTransientMeterGap(undefined)).toBe(false);
	});
});

describe("LiveAudioMeter — a transient gap never draws a band", () => {
	it("shows NO band at any point across live → one gap frame → live", () => {
		const { container } = mountedLive();
		expect(bars(container)).toBe(2);

		// The blip itself: the operator must not see the band even for this paint.
		emit(gap());
		expect(bandShown(container)).toBe(false);
		expect(bandText(container)).toBeNull();
		// …and the reading they already had is what stays on screen. Blanking the
		// bars is a different flash, not the absence of one.
		expect(bars(container)).toBe(2);

		emit(live(1));
		expect(bandShown(container)).toBe(false);
		expect(bars(container)).toBe(2);
	});

	it("holds through a whole burst of gap frames, up to the deadline", () => {
		const { container } = mountedLive();

		// 5 frames at the engine cadence = 1000 ms, still inside the window.
		for (let i = 0; i < 5; i += 1) {
			emit(gap());
			expect(bandShown(container)).toBe(false);
		}
		expect(bars(container)).toBe(2);

		emit(live(1));
		expect(bandShown(container)).toBe(false);
		expect(bars(container)).toBe(2);
	});

	it("draws the band the instant the deadline passes, not a tick later", () => {
		const { container } = mountedLive();
		setAudioLevel(structuredClone(gap()));
		flushSync();

		vi.advanceTimersByTime(METER_UNAVAILABLE_DISPLAY_GRACE_MS - 1);
		flushSync();
		expect(bandShown(container)).toBe(false);

		vi.advanceTimersByTime(1);
		flushSync();
		expect(bandShown(container)).toBe(true);
	});
});

describe("LiveAudioMeter — a SUSTAINED gap is still reported honestly", () => {
	// The over-debouncing guard. A grace that re-armed per frame, or that never
	// resolved, would silently retire the band the meter exists to draw — a worse
	// regression than the blink it is fixing.
	it("draws the band while gap frames KEEP arriving at the engine cadence", () => {
		const { container } = mountedLive();

		// 15 frames = 3 s of uninterrupted gap, well past the 1200 ms window.
		for (let i = 0; i < 15; i += 1) emit(gap());

		expect(bandShown(container)).toBe(true);
		expect(bars(container)).toBe(0);
		// The engine's own reason survives the wait — a graced band must not
		// degrade into the anonymous "Meter unavailable".
		expect(bandText(container)).toContain("Switching");
		// And it got there without the staleness watchdog: a repeated `unavailable`
		// marker counts as life, so `stale` is still false.
		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
	});

	it("keeps the band up for as long as the gap lasts", () => {
		const { container } = mountedLive();
		for (let i = 0; i < 15; i += 1) emit(gap());
		expect(bandShown(container)).toBe(true);

		for (let i = 0; i < 25; i += 1) emit(gap());
		expect(bandShown(container)).toBe(true);
		expect(bars(container)).toBe(0);
	});

	it("still ages a stopped feed out at the staleness deadline, ungraced", () => {
		// The grace covers the engine's `unavailable` marker and nothing else.
		// A feed that simply stops has no marker to grace, so `stale` must resolve
		// on its own unchanged deadline.
		const { container } = mountedLive();

		vi.advanceTimersByTime(AUDIO_METER_STALE_MS + 1);
		flushSync();

		expect(meter(container)?.getAttribute("data-stale")).toBe("true");
		expect(bandShown(container)).toBe(true);
		expect(bars(container)).toBe(0);
	});

	it("draws the band immediately for a gap that had no live reading behind it", () => {
		// Nothing to hold over: the first frame this meter ever sees is the gap,
		// so there is no transition to suppress and the honest answer is instant.
		const { container } = render(LiveAudioMeter);
		flushSync();

		setAudioLevel(structuredClone(gap("no_device")));
		flushSync();

		expect(bandShown(container)).toBe(true);
		expect(bandText(container)).toContain("No audio device");
		expect(bars(container)).toBe(0);
	});
});

describe("LiveAudioMeter — recovery out of a rendered band is INSTANT", () => {
	it("restores the bars on the very next live frame, with no delay", () => {
		const { container } = mountedLive();
		for (let i = 0; i < 15; i += 1) emit(gap());
		expect(bandShown(container)).toBe(true);

		// No timer is advanced beyond the frame's own cadence: the band clears on
		// the frame itself. A grace on the way BACK would leave it up here.
		emit(live(1));
		expect(bandShown(container)).toBe(false);
		expect(bars(container)).toBe(2);
	});

	it("re-arms the grace for a LATER blip once the meter is live again", () => {
		const { container } = mountedLive();
		for (let i = 0; i < 15; i += 1) emit(gap());
		expect(bandShown(container)).toBe(true);

		emit(live(1));
		expect(bandShown(container)).toBe(false);

		// A second, transient gap must be suppressed exactly like the first —
		// the grace is per gap, not once per session.
		emit(gap());
		expect(bandShown(container)).toBe(false);
		expect(bars(container)).toBe(2);
	});
});

describe("LiveAudioMeter — a STATED gap is never graced", () => {
	// `mode_none` is the operator's own "No audio" pick and `embedded_audio` is a
	// property of the selected source. Neither is a transient engine gap, so
	// delaying either would make a deliberate action look laggy — and would
	// change behaviour this effort explicitly leaves alone.
	it("renders `mode_none` immediately, with its own copy", () => {
		const { container } = mountedLive();
		expect(bars(container)).toBe(2);

		setAudioLevel(structuredClone(gap("mode_none")));
		flushSync();

		expect(bandShown(container)).toBe(true);
		expect(bandText(container)).toContain("Audio disabled");
		expect(bars(container)).toBe(0);
	});

	it("renders `embedded_audio` immediately, with its own copy", () => {
		const { container } = mountedLive();

		setAudioLevel(structuredClone(gap("embedded_audio")));
		flushSync();

		expect(bandShown(container)).toBe(true);
		expect(bandText(container)).toContain("Waiting for stream audio");
		expect(bars(container)).toBe(0);
		// A retired reading names no device — unchanged.
		expect(
			container.querySelector('[data-testid="live-audio-meter-device"]'),
		).toBeNull();
	});

	it("keeps the operator's silence on screen for as long as it is selected", () => {
		const { container } = mountedLive();
		for (let i = 0; i < 20; i += 1) emit(gap("mode_none"));

		expect(bandShown(container)).toBe(true);
		expect(bandText(container)).toContain("Audio disabled");
		expect(meter(container)?.getAttribute("data-stale")).toBe("false");
	});

	it("leaves the selection gate's own precedence untouched", () => {
		// `superseded` retires the reading the PREVIOUS pick produced, instantly
		// and without a reason — the grace must not reach that path.
		const { container } = mountedLive();
		expect(bars(container)).toBe(2);

		setAudioSelection("No audio");
		flushSync();

		expect(meter(container)?.getAttribute("data-superseded")).toBe("true");
		expect(bandShown(container)).toBe(true);
		expect(bars(container)).toBe(0);
	});
});
