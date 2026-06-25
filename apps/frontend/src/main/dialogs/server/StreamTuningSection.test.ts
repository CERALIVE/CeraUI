// @vitest-environment jsdom
/**
 * StreamTuningSection — receiver-capability-gated card (Task 16).
 *
 * Two top-level states, asserted against the resolved experience:
 *  - CeraLive receiver → FEC / recovery / preset chips ENABLED, no banner.
 *  - non-CeraLive      → those controls DISABLED with a reason tooltip (the
 *    `title` attribute, never hidden) + the BELABOX-compatible banner shown.
 */
import { render, screen } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { StreamTuningExperience } from "$lib/streaming/receiver-experience";
import StreamTuningSection from "./StreamTuningSection.svelte";

const CERALIVE: StreamTuningExperience = {
	isCeraLiveReceiver: true,
	latencyEnabled: true,
	latencyRange: { min: 100, default: 1500, max: 5000 },
	fecEnabled: true,
	recoveryModeEnabled: true,
	presetsEnabled: true,
	availableProfiles: [
		"balanced",
		"low-latency",
		"resilient",
		"classic",
		"low-latency-fec",
	],
	defaultProfile: "balanced",
	showBelaboxBanner: false,
};

const NON_CERALIVE: StreamTuningExperience = {
	isCeraLiveReceiver: false,
	latencyEnabled: true,
	latencyRange: { min: 100, default: 1500, max: 2000 },
	fecEnabled: false,
	fecDisabledReasonKey: "settings.streamTuning.reasonNonCeraLive",
	recoveryModeEnabled: false,
	recoveryModeDisabledReasonKey: "settings.streamTuning.reasonNonCeraLive",
	presetsEnabled: false,
	presetsDisabledReasonKey: "settings.streamTuning.reasonNonCeraLive",
	availableProfiles: ["classic"],
	defaultProfile: "classic",
	showBelaboxBanner: true,
};

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

const btn = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;

describe("StreamTuningSection — CeraLive receiver", () => {
	it("enables FEC, recovery mode, and the preset chips", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500 },
		});

		expect(
			screen.getByTestId("stream-tuning").getAttribute("data-receiver-kind"),
		).toBe("ceralive");
		expect(screen.getByTestId("stream-tuning-ceralive-badge")).toBeTruthy();
		expect(btn("stream-tuning-fec").disabled).toBe(false);
		expect(btn("stream-tuning-recovery").disabled).toBe(false);
		// The full advertised profile set renders as enabled chips.
		expect(btn("stream-tuning-preset-balanced").disabled).toBe(false);
		expect(btn("stream-tuning-preset-low-latency-fec").disabled).toBe(false);
		expect(screen.queryByTestId("stream-tuning-belabox-banner")).toBeNull();
	});

	it("locks every control while a stream is live", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500, isStreaming: true },
		});
		expect(btn("stream-tuning-fec").disabled).toBe(true);
		expect(btn("stream-tuning-recovery").disabled).toBe(true);
		expect(btn("stream-tuning-preset-balanced").disabled).toBe(true);
	});
});

describe("StreamTuningSection — non-CeraLive receiver", () => {
	it("disables advanced controls with a reason tooltip and shows the BELABOX banner", () => {
		render(StreamTuningSection, {
			props: { experience: NON_CERALIVE, latencyMs: 1500 },
		});

		expect(
			screen.getByTestId("stream-tuning").getAttribute("data-receiver-kind"),
		).toBe("non-ceralive");

		const fec = btn("stream-tuning-fec");
		const recovery = btn("stream-tuning-recovery");
		const classic = btn("stream-tuning-preset-classic");
		expect(fec.disabled).toBe(true);
		expect(recovery.disabled).toBe(true);
		expect(classic.disabled).toBe(true);

		const reason = "Available only with a CeraLive receiver.";
		expect(fec.getAttribute("title")).toBe(reason);
		expect(recovery.getAttribute("title")).toBe(reason);
		expect(classic.getAttribute("title")).toBe(reason);

		expect(screen.getByTestId("stream-tuning-belabox-banner")).toBeTruthy();
		expect(screen.queryByTestId("stream-tuning-preset-balanced")).toBeNull();
		expect(screen.queryByTestId("stream-tuning-ceralive-badge")).toBeNull();
	});

	it("keeps the latency control available regardless of receiver kind", () => {
		render(StreamTuningSection, {
			props: { experience: NON_CERALIVE, latencyMs: 1800 },
		});
		const latency = screen.getByTestId("stream-tuning-latency");
		expect(latency).toBeTruthy();
		expect(latency.textContent).toContain("1800");
	});
});
