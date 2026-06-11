// @vitest-environment jsdom
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import AudioLevelMeter from "./AudioLevelMeter.svelte";

function meterOf(container: HTMLElement): HTMLElement {
	const meter = container.querySelector<HTMLElement>(
		'[data-testid="audio-level-meter"]',
	);
	expect(meter, "meter must render").not.toBeNull();
	return meter as HTMLElement;
}

describe("AudioLevelMeter (Task 33)", () => {
	it("renders one channel meter per reported channel", () => {
		const { container } = render(AudioLevelMeter, {
			props: { rmsDb: [-12, -20], peakDb: [-6, -10] },
		});
		const meter = meterOf(container);

		expect(meter.getAttribute("data-channels")).toBe("2");
		expect(meter.getAttribute("data-silent")).toBe("false");
		expect(
			meter.querySelectorAll('[data-testid="audio-channel"]'),
		).toHaveLength(2);
	});

	it("maps dBFS into the 0..100 meter range (-60 dB floor, 0 dB full)", () => {
		const { container } = render(AudioLevelMeter, {
			props: { rmsDb: [-6], peakDb: [0] },
		});
		const channel = meterOf(container).querySelector<HTMLElement>(
			'[data-testid="audio-channel"]',
		);
		// (-6 - -60) / 60 = 0.9 → 90
		expect(channel?.getAttribute("aria-valuenow")).toBe("90");
	});

	it("falls to the silent floor state when every channel is digital silence", () => {
		const { container } = render(AudioLevelMeter, {
			props: { rmsDb: [-1e6, -1e6], peakDb: [-1e6, -1e6] },
		});
		const meter = meterOf(container);

		expect(meter.getAttribute("data-silent")).toBe("true");
		expect(meter.querySelector('[data-testid="audio-silent"]')).not.toBeNull();
		expect(
			meter.querySelectorAll('[data-testid="audio-channel"]'),
		).toHaveLength(0);
	});

	it("treats an empty feed as silent without crashing", () => {
		const { container } = render(AudioLevelMeter, { props: {} });
		expect(meterOf(container).getAttribute("data-silent")).toBe("true");
	});
});
