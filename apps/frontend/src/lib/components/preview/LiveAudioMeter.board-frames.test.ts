// @vitest-environment jsdom
//
// The three `audio-level` payloads a real Rock 5B+ broadcast over the MAIN WS
// after the "Auto"-resolves-for-the-meter fix, driven through the actual consumer
// path (`getAudioLevel()` → the liveness gates → `AudioLevelMeter`).
//
// This is the one path no e2e spec reaches: the meter's existing e2e coverage
// drives `PreviewCanvas`, which parses `audio-level` off the PREVIEW socket and
// hands it straight to `AudioLevelMeter`, bypassing `LiveAudioMeter` and the
// backend bridge entirely. The frames below are transcribed verbatim from a board
// capture (see `.omo` board-proof record), so a regression in the bridge's
// projection would have to change these bytes to escape this file.
//
// The three states are DISTINCT and must stay distinct:
//   a) HDMI + Auto  → the honest `no_device` gap, because the RK3588 HDMI-RX audio
//                     half owns no capture PCM. NOT another card's bars.
//   b) USB camera + Auto → that camera's OWN card, live and moving.
//   c) a capture-capable card carrying genuine silence → the `silent` state, and it
//      must stay `silent` forever rather than aging into `unavailable`.
import type { AudioLevelMessage, StatusResponse } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentLevel: AudioLevelMessage | undefined;
let currentStatus: StatusResponse | undefined;

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getAudioLevel: () => currentLevel,
	// `config.asrc` never leaves the "Auto" sentinel in any of these scenarios —
	// which is precisely why the frontend selection gate cannot see the card move
	// and the backend has to resolve the pick before it reaches the wire.
	getConfig: () => ({ asrc: "Auto" }),
	getStatus: () => currentStatus,
}));

import LiveAudioMeter from "./LiveAudioMeter.svelte";

/** HDMI (`/dev/video0`) selected, `asrc: "Auto"` — resolved to `hw:CARD=rockchiphdmiin`. */
const BOARD_HDMI_AUTO: AudioLevelMessage = {
	unavailable: true,
	reason: "no_device",
};

/** Osmo Pocket 3 (`/dev/video3`) selected, `asrc: "Auto"` — rule 5 → `card:DJIPocket3`. */
const BOARD_OSMO_AUTO_FIRST: AudioLevelMessage = {
	source: { identity: "card:DJIPocket3", owner: "sidecar" },
	channels: 2,
	rms_db: [-38.57877582271495, -38.81071538109665],
	peak_db: [-30.520002345860526, -30.352537084279852],
	floor_db: -1000000,
};
const BOARD_OSMO_AUTO_NEXT: AudioLevelMessage = {
	source: { identity: "card:DJIPocket3", owner: "sidecar" },
	channels: 2,
	rms_db: [-39.614328765129414, -39.773781935062416],
	peak_db: [-30.01019170333563, -30.511107424818896],
	floor_db: -1000000,
};

/** RØDE HDMI-to-USB-C (`/dev/video1`) selected, `asrc: "Auto"` — rule 5 → `card:usbaudio`,
 *  which has a real capture PCM but nothing on its HDMI input: genuine silence. */
const BOARD_RODE_AUTO_SILENT: AudioLevelMessage = {
	source: { identity: "card:usbaudio", owner: "sidecar" },
	channels: 2,
	rms_db: [-699.9999998436322, -699.9999998436322],
	peak_db: [-349.9999999218161, -349.9999999218161],
	floor_db: -1000000,
};

function innerMeter(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>(
		'[data-testid="audio-level-meter"]',
	);
	if (el === null) throw new Error("AudioLevelMeter did not render");
	return el;
}

function state(container: HTMLElement): {
	unavailable: string | null;
	silent: string | null;
	reason: string | null;
	channels: number;
} {
	const el = innerMeter(container);
	return {
		unavailable: el.getAttribute("data-unavailable"),
		silent: el.getAttribute("data-silent"),
		reason:
			el
				.querySelector('[data-testid="audio-unavailable"]')
				?.textContent?.trim() ?? null,
		channels: el.querySelectorAll('[data-testid="audio-channel"]').length,
	};
}

describe('LiveAudioMeter — real board frames under `asrc: "Auto"`', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		currentLevel = undefined;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("HDMI + Auto renders the `no_device` gap, and draws NO bars", () => {
		currentLevel = BOARD_HDMI_AUTO;
		const { container } = render(LiveAudioMeter);

		const s = state(container);
		expect(s.unavailable).toBe("true");
		// The reported defect was bars here — a different card's real audio under
		// the HDMI pick's label. Zero channels is the whole point of the fix.
		expect(s.channels).toBe(0);
		expect(s.reason).not.toBeNull();
		// The meter is still MOUNTED. An absent meter is a different wrong outcome.
		expect(
			container.querySelector('[data-testid="live-audio-meter"]'),
		).not.toBeNull();
	});

	it("HDMI + Auto stays `no_device` while the frame repeats — it never becomes bars", () => {
		currentLevel = BOARD_HDMI_AUTO;
		const { container } = render(LiveAudioMeter);
		for (let i = 0; i < 12; i += 1) vi.advanceTimersByTime(500);
		const s = state(container);
		expect(s.unavailable).toBe("true");
		expect(s.channels).toBe(0);
	});

	it("USB camera + Auto renders that camera's OWN card live — Auto is not muted", () => {
		currentLevel = BOARD_OSMO_AUTO_FIRST;
		const { container, rerender } = render(LiveAudioMeter);

		expect(state(container).unavailable).toBe("false");
		expect(state(container).channels).toBe(2);
		expect(state(container).silent).toBe("false");

		// A second, DIFFERENT board frame keeps it live: the watchdog keys on
		// content, so moving audio can never age out.
		currentLevel = BOARD_OSMO_AUTO_NEXT;
		void rerender({});
		vi.advanceTimersByTime(1_000);
		expect(state(container).unavailable).toBe("false");
		expect(state(container).channels).toBe(2);
	});

	it("genuine digital silence renders `silent`, NOT `unavailable`", () => {
		currentLevel = BOARD_RODE_AUTO_SILENT;
		const { container } = render(LiveAudioMeter);

		const s = state(container);
		// The two states the fix must keep apart: "this card structurally cannot
		// produce audio" (a) vs "this card produces audio and it is quiet" (c).
		expect(s.unavailable).toBe("false");
		expect(s.silent).toBe("true");
		expect(
			innerMeter(container).querySelector('[data-testid="audio-silent"]'),
		).not.toBeNull();
	});

	it("repeated digital silence stays `silent` — the frozen-content watchdog exempts it", () => {
		currentLevel = BOARD_RODE_AUTO_SILENT;
		const { container } = render(LiveAudioMeter);
		// Well past AUDIO_METER_STALE_MS with byte-identical frames.
		for (let i = 0; i < 20; i += 1) vi.advanceTimersByTime(500);
		const s = state(container);
		expect(s.unavailable).toBe("false");
		expect(s.silent).toBe("true");
	});
});
