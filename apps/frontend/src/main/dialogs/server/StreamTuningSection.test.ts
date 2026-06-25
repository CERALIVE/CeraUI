// @vitest-environment jsdom
/**
 * StreamTuningSection — receiver-capability-gated card (Tasks 16-19).
 *
 * Two top-level states, asserted against the resolved experience:
 *  - CeraLive receiver → latency slider + FEC switch + recovery segmented
 *    control + preset chips, all interactive; no banner.
 *  - non-CeraLive      → latency only; FEC / recovery / presets disabled with a
 *    reason tooltip (the `title` attribute, never hidden) + the
 *    BELABOX-compatible banner shown.
 *
 * Plus the per-control wiring the follow-up tasks added: the latency slider
 * (Task 17), the FEC switch (Task 18), and the recovery segmented control
 * (Task 19) emit through their callbacks and reflect the current value.
 */
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { StreamTuningExperience } from "$lib/streaming/receiver-experience";
import StreamTuningSection from "./StreamTuningSection.svelte";

const CERALIVE: StreamTuningExperience = {
	isCeraLiveReceiver: true,
	latencyEnabled: true,
	latencyRange: { min: 100, default: 1500, max: 5000 },
	fecEnabled: true,
	recoveryModeEnabled: true,
	defaultRecoveryMode: "standard",
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
	recoveryModeDisabledReasonKey: "settings.streamTuning.reasonReceiverManaged",
	defaultRecoveryMode: "standard",
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
	it("enables FEC, recovery segments, and the preset chips", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500 },
		});

		expect(
			screen.getByTestId("stream-tuning").getAttribute("data-receiver-kind"),
		).toBe("ceralive");
		expect(screen.getByTestId("stream-tuning-ceralive-badge")).toBeTruthy();
		expect(btn("stream-tuning-fec").disabled).toBe(false);
		expect(btn("stream-tuning-recovery-standard").disabled).toBe(false);
		expect(btn("stream-tuning-recovery-bandwidth-saver").disabled).toBe(false);
		expect(btn("stream-tuning-preset-balanced").disabled).toBe(false);
		expect(btn("stream-tuning-preset-low-latency-fec").disabled).toBe(false);
		expect(screen.queryByTestId("stream-tuning-belabox-banner")).toBeNull();
	});

	it("locks every control while a stream is live", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500, isStreaming: true },
		});
		expect(btn("stream-tuning-fec").disabled).toBe(true);
		expect(btn("stream-tuning-recovery-standard").disabled).toBe(true);
		expect(btn("stream-tuning-preset-balanced").disabled).toBe(true);
		expect(
			(screen.getByTestId("stream-tuning-latency-slider") as HTMLInputElement)
				.disabled,
		).toBe(true);
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
		const standard = btn("stream-tuning-recovery-standard");
		const classic = btn("stream-tuning-preset-classic");
		expect(fec.disabled).toBe(true);
		expect(standard.disabled).toBe(true);
		expect(classic.disabled).toBe(true);

		expect(fec.getAttribute("title")).toBe(
			"Available only with a CeraLive receiver.",
		);
		// Recovery is receiver-managed for an unproven receiver, NOT the generic
		// "needs a CeraLive receiver" reason.
		expect(
			screen.getByTestId("stream-tuning-recovery").getAttribute("title"),
		).toBe("Receiver-managed.");

		expect(screen.getByTestId("stream-tuning-belabox-banner")).toBeTruthy();
		expect(screen.queryByTestId("stream-tuning-preset-balanced")).toBeNull();
		expect(screen.queryByTestId("stream-tuning-ceralive-badge")).toBeNull();
	});

	it("keeps the latency slider available regardless of receiver kind", () => {
		render(StreamTuningSection, {
			props: { experience: NON_CERALIVE, latencyMs: 1800 },
		});
		const slider = screen.getByTestId(
			"stream-tuning-latency-slider",
		) as HTMLInputElement;
		expect(slider.disabled).toBe(false);
		expect(slider.max).toBe("2000");
		expect(
			screen.getByTestId("stream-tuning-latency-value").textContent,
		).toContain("1.8 s");
	});
});

describe("StreamTuningSection — latency slider (Task 17)", () => {
	it("renders the value pill in seconds and bounds from the experience range", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 2000 },
		});
		const slider = screen.getByTestId(
			"stream-tuning-latency-slider",
		) as HTMLInputElement;
		expect(slider.min).toBe("100");
		expect(slider.max).toBe("5000");
		expect(slider.value).toBe("2000");
		expect(
			screen.getByTestId("stream-tuning-latency-value").textContent,
		).toContain("2 s");
	});

	it("emits onLatencyChange on input", async () => {
		const onLatencyChange = vi.fn();
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500, onLatencyChange },
		});
		const slider = screen.getByTestId(
			"stream-tuning-latency-slider",
		) as HTMLInputElement;
		await fireEvent.input(slider, { target: { value: "2500" } });
		expect(onLatencyChange).toHaveBeenCalledWith(2500);
	});

	it("shows the negotiated read-back value while streaming", () => {
		render(StreamTuningSection, {
			props: {
				experience: CERALIVE,
				latencyMs: 1500,
				effectiveLatencyMs: 3000,
				isStreaming: true,
			},
		});
		expect(
			screen.getByTestId("stream-tuning-latency-value").textContent,
		).toContain("3 s");
	});
});

describe("StreamTuningSection — FEC switch (Task 18)", () => {
	it("defaults OFF and emits onFecChange", async () => {
		const onFecChange = vi.fn();
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500, onFecChange },
		});
		const fec = btn("stream-tuning-fec");
		expect(fec.getAttribute("aria-checked")).toBe("false");
		await fireEvent.click(fec);
		expect(onFecChange).toHaveBeenCalledWith(true);
	});

	it("reflects an enabled FEC value", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500, fecEnabled: true },
		});
		expect(btn("stream-tuning-fec").getAttribute("aria-checked")).toBe("true");
	});
});

describe("StreamTuningSection — recovery segmented control (Task 19)", () => {
	it("defaults to Standard and emits onRecoveryChange", async () => {
		const onRecoveryChange = vi.fn();
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500, onRecoveryChange },
		});
		expect(
			btn("stream-tuning-recovery-standard").getAttribute("aria-pressed"),
		).toBe("true");
		await fireEvent.click(btn("stream-tuning-recovery-bandwidth-saver"));
		expect(onRecoveryChange).toHaveBeenCalledWith("bandwidth-saver");
	});

	it("reflects a bandwidth-saver selection", () => {
		render(StreamTuningSection, {
			props: {
				experience: CERALIVE,
				latencyMs: 1500,
				recoveryMode: "bandwidth-saver",
			},
		});
		expect(
			btn("stream-tuning-recovery-bandwidth-saver").getAttribute(
				"aria-pressed",
			),
		).toBe("true");
		expect(
			btn("stream-tuning-recovery-standard").getAttribute("aria-pressed"),
		).toBe("false");
	});
});
