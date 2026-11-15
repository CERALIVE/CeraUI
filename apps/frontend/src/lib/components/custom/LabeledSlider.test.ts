// @vitest-environment jsdom
/**
 * LabeledSlider — the one slider the Live screen and the Encoder dialog use.
 *
 *   • the accessible name, description and value text sit on the thumb, the
 *     element with `role="slider"` that takes focus, never on the root;
 *   • it runs with the reading direction: in Arabic the minimum is on the right.
 */
import { setLocale } from "@ceraui/i18n/svelte";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import LabeledSlider from "./LabeledSlider.svelte";

beforeAll(() => {
	// bits-ui's Slider installs a ResizeObserver, absent in jsdom.
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
});

afterEach(() => {
	cleanup();
	setLocale("en");
});

function renderSlider(extra: Record<string, unknown> = {}) {
	return render(LabeledSlider, {
		props: {
			label: "Gain for Mic",
			max: 12,
			min: -60,
			step: 1,
			value: -60,
			...extra,
		},
	});
}

describe("LabeledSlider", () => {
	it("names the thumb, not the root", () => {
		const { container } = renderSlider();

		const thumb = screen.getByRole("slider", { name: "Gain for Mic" });
		expect(thumb.getAttribute("data-slot")).toBe("slider-thumb");
		expect(
			container
				.querySelector('[data-slot="slider"]')
				?.hasAttribute("aria-label"),
		).toBe(false);
	});

	it("describes the thumb and reads its value as text", () => {
		renderSlider({ describedBy: "mix-note", valueText: "-60 dB" });

		const thumb = screen.getByRole("slider");
		expect(thumb.getAttribute("aria-describedby")).toBe("mix-note");
		expect(thumb.getAttribute("aria-valuetext")).toBe("-60 dB");
	});

	it("puts the minimum on the left in English and on the right in Arabic", () => {
		renderSlider();
		expect(screen.getByRole("slider").style.left).toBe("0%");
		cleanup();

		setLocale("ar");
		renderSlider();
		const thumb = screen.getByRole("slider");
		expect(thumb.style.right).toBe("0%");
		expect(thumb.style.left).toBe("");
	});
});
