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
		expect(screen.queryByTestId("stream-tuning-belabox-badge")).toBeNull();
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
		expect(
			screen.getByTestId("stream-tuning-belabox-badge").textContent,
		).toContain("Standard (BELABOX-compatible)");
		// Task 20: capability-unavailable preset chips are disabled-with-reason,
		// NEVER hidden — so balanced renders (disabled) on a non-CeraLive receiver.
		const balancedChip = btn("stream-tuning-preset-balanced");
		expect(balancedChip.disabled).toBe(true);
		expect(balancedChip.getAttribute("title")).toBe(
			"Available only with a CeraLive receiver.",
		);
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

describe("StreamTuningSection — accessibility (Task 22)", () => {
	it("names the card region and gives the slider an accessible name + value text", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500 },
		});

		const card = screen.getByTestId("stream-tuning");
		expect(card.getAttribute("aria-labelledby")).toBe("stream-tuning-title");
		expect(card.querySelector("#stream-tuning-title")?.textContent).toContain(
			"Stream tuning",
		);

		const slider = screen.getByTestId(
			"stream-tuning-latency-slider",
		) as HTMLInputElement;
		expect(slider.getAttribute("aria-label")).toBe("Latency");
		expect(slider.getAttribute("aria-valuetext")).toContain("1.5 s");
	});

	it("keeps every disabled control labelled and reasoned for a non-CeraLive receiver", () => {
		render(StreamTuningSection, {
			props: { experience: NON_CERALIVE, latencyMs: 1500 },
		});

		const fec = btn("stream-tuning-fec");
		expect(fec.getAttribute("aria-label")).toBe("Forward error correction");
		expect(fec.getAttribute("title")).toBe(
			"Available only with a CeraLive receiver.",
		);
		for (const id of [
			"stream-tuning-recovery-standard",
			"stream-tuning-recovery-bandwidth-saver",
		]) {
			expect(btn(id).getAttribute("title")).toBe("Receiver-managed.");
		}
		expect(btn("stream-tuning-preset-classic").getAttribute("title")).toBe(
			"Available only with a CeraLive receiver.",
		);
	});
});

describe("StreamTuningSection — preset snap-chips (Task 20)", () => {
	const CERALIVE_NO_FEC: StreamTuningExperience = {
		...CERALIVE,
		fecEnabled: false,
		fecDisabledReasonKey: "settings.streamTuning.reasonFecUnsupported",
	};

	it("pre-selects Balanced at the default 1500 ms / FEC off / Standard state", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500 },
		});
		expect(
			btn("stream-tuning-preset-balanced").getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			btn("stream-tuning-preset-custom").getAttribute("aria-pressed"),
		).toBe("false");
	});

	it("clicking Low Latency sets ~500 ms + FEC off + Standard via the callbacks", async () => {
		const onLatencyChange = vi.fn();
		const onFecChange = vi.fn();
		const onRecoveryChange = vi.fn();
		render(StreamTuningSection, {
			props: {
				experience: CERALIVE,
				latencyMs: 1500,
				onLatencyChange,
				onFecChange,
				onRecoveryChange,
			},
		});
		await fireEvent.click(btn("stream-tuning-preset-low-latency"));
		expect(onLatencyChange).toHaveBeenCalledWith(500);
		expect(onFecChange).toHaveBeenCalledWith(false);
		expect(onRecoveryChange).toHaveBeenCalledWith("standard");
	});

	it("clicking Classic sets ~2000 ms + Bandwidth Saver recovery", async () => {
		const onLatencyChange = vi.fn();
		const onRecoveryChange = vi.fn();
		render(StreamTuningSection, {
			props: {
				experience: CERALIVE,
				latencyMs: 1500,
				onLatencyChange,
				onRecoveryChange,
			},
		});
		await fireEvent.click(btn("stream-tuning-preset-classic"));
		expect(onLatencyChange).toHaveBeenCalledWith(2000);
		expect(onRecoveryChange).toHaveBeenCalledWith("bandwidth-saver");
	});

	it("clicking Low Latency + FEC turns FEC on and sets ~800 ms", async () => {
		const onLatencyChange = vi.fn();
		const onFecChange = vi.fn();
		render(StreamTuningSection, {
			props: {
				experience: CERALIVE,
				latencyMs: 1500,
				onLatencyChange,
				onFecChange,
			},
		});
		await fireEvent.click(btn("stream-tuning-preset-low-latency-fec"));
		expect(onFecChange).toHaveBeenCalledWith(true);
		expect(onLatencyChange).toHaveBeenCalledWith(800);
	});

	it("flips the active chip to Custom when a control diverges from every preset", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1234 },
		});
		const custom = btn("stream-tuning-preset-custom");
		expect(custom.getAttribute("aria-pressed")).toBe("true");
		expect(custom.disabled).toBe(false);
		expect(
			btn("stream-tuning-preset-balanced").getAttribute("aria-pressed"),
		).toBe("false");
	});

	it("disables the FEC preset with the FEC reason on a non-FEC CeraLive build", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE_NO_FEC, latencyMs: 1500 },
		});
		const fecChip = btn("stream-tuning-preset-low-latency-fec");
		expect(fecChip.disabled).toBe(true);
		expect(fecChip.getAttribute("title")).toBe(
			"This CeraLive receiver's libsrt build doesn't support FEC.",
		);
		// A non-FEC preset stays interactive on the same receiver.
		expect(btn("stream-tuning-preset-balanced").disabled).toBe(false);
	});

	it("locks every preset chip while a stream is live", () => {
		render(StreamTuningSection, {
			props: { experience: CERALIVE, latencyMs: 1500, isStreaming: true },
		});
		for (const id of [
			"low-latency",
			"balanced",
			"resilient",
			"low-latency-fec",
			"classic",
		]) {
			expect(btn(`stream-tuning-preset-${id}`).disabled).toBe(true);
		}
	});
});
