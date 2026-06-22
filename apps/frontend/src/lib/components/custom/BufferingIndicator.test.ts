// @vitest-environment jsdom
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import type { BufferingState } from "$lib/stores/buffering.svelte";
import BufferingIndicator from "./BufferingIndicator.svelte";

function indicator(container: HTMLElement): HTMLElement | null {
	return container.querySelector('[data-testid="buffering-indicator"]');
}

describe("BufferingIndicator (Task 34)", () => {
	it("renders nothing when the capability is absent (state null)", () => {
		const { container } = render(BufferingIndicator, {
			props: { state: null },
		});
		expect(indicator(container)).toBeNull();
	});

	it("renders the calm indicator with spooled bytes when buffering is active", () => {
		const state: BufferingState = {
			active: true,
			spooledBytes: 1024 * 1024 * 12,
			dataHeadroomBytes: null,
			diskWarning: false,
		};
		const { container } = render(BufferingIndicator, { props: { state } });
		const el = indicator(container);
		expect(el).not.toBeNull();
		expect(el?.getAttribute("role")).toBe("status");
		expect(
			container.querySelector('[data-testid="buffering-spooled"]')?.textContent,
		).toContain("12");
	});

	it("renders nothing on recovery (active false)", () => {
		const state: BufferingState = {
			active: false,
			spooledBytes: null,
			dataHeadroomBytes: null,
			diskWarning: false,
		};
		const { container } = render(BufferingIndicator, { props: { state } });
		expect(indicator(container)).toBeNull();
	});
});
