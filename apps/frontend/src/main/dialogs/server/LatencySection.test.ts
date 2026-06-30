// @vitest-environment jsdom
/**
 * LatencySection — the single honest tuning control (receiver-coherence).
 *
 * Latency is the only knob: the slider reflects the value, emits onLatencyChange,
 * shows the negotiated label while streaming, and locks while streaming. No FEC /
 * recovery / presets controls exist here.
 */
import { LL } from "@ceraui/i18n/svelte";
import { fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import LatencySection from "./LatencySection.svelte";

const t = get(LL);
const RANGE = { min: 100, default: 2000, max: 5000 };

describe("LatencySection — latency-only control", () => {
	it("renders one slider reflecting the value with a11y bounds", () => {
		const { container } = render(LatencySection, {
			props: { latencyMs: 2000, range: RANGE, onLatencyChange: () => {} },
		});
		const slider = container.querySelector(
			'[data-testid="latency-slider"]',
		) as HTMLInputElement;
		expect(slider).not.toBeNull();
		expect(slider.value).toBe("2000");
		expect(slider.getAttribute("aria-valuemin")).toBe("100");
		expect(slider.getAttribute("aria-valuemax")).toBe("5000");
		expect(slider.getAttribute("aria-valuenow")).toBe("2000");
	});

	it("emits onLatencyChange on input", async () => {
		const onLatencyChange = vi.fn();
		const { container } = render(LatencySection, {
			props: { latencyMs: 2000, range: RANGE, onLatencyChange },
		});
		const slider = container.querySelector(
			'[data-testid="latency-slider"]',
		) as HTMLInputElement;
		await fireEvent.input(slider, { target: { value: "2500" } });
		expect(onLatencyChange).toHaveBeenCalledWith(2500);
	});

	it("shows the negotiated label and locks the slider while streaming", () => {
		const { container } = render(LatencySection, {
			props: {
				latencyMs: 2000,
				range: RANGE,
				effectiveLatencyMs: 2300,
				isStreaming: true,
				onLatencyChange: () => {},
			},
		});
		const slider = container.querySelector(
			'[data-testid="latency-slider"]',
		) as HTMLInputElement;
		expect(slider.disabled).toBe(true);
		expect(container.textContent).toContain(t.settings.latencyNegotiated());
	});

	it("has no FEC/recovery/preset controls", () => {
		const { container } = render(LatencySection, {
			props: { latencyMs: 2000, range: RANGE, onLatencyChange: () => {} },
		});
		expect(
			container.querySelector('[data-testid="stream-tuning-fec"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="stream-tuning-presets"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="stream-tuning-recovery"]'),
		).toBeNull();
	});
});
