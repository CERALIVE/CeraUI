// @vitest-environment jsdom
/**
 * InfoPopover — per-field "?" education affordance (Task 9).
 *
 * Locks the accessibility + reason contract: the trigger is a real, keyboard-
 * reachable button with an accessible name; opening it reveals the explanation;
 * and the distinct "disabled with reason" band renders only when a `reason` is
 * supplied (so it never reads like a "coming soon" future).
 */
import { render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";

import InfoPopover from "./InfoPopover.svelte";

const BASE = {
	title: "Video source",
	body: "Where the encoder pulls video from.",
} as const;

describe("InfoPopover", () => {
	it("renders a keyboard-reachable button trigger with an accessible name", () => {
		render(InfoPopover, { props: { ...BASE, testId: "info-x" } });

		const trigger = screen.getByTestId("info-x");
		expect(trigger.tagName).toBe("BUTTON");
		// A bare "?" glyph has no text; the accessible name comes from aria-label.
		expect(trigger.getAttribute("aria-label")).toBeTruthy();
		// Native <button> is Tab-reachable without a forced tabindex.
		expect(trigger.getAttribute("tabindex")).toBeNull();
	});

	it("honors an explicit ariaLabel override", () => {
		render(InfoPopover, {
			props: { ...BASE, ariaLabel: "Help for source", testId: "info-x" },
		});
		expect(screen.getByTestId("info-x").getAttribute("aria-label")).toBe(
			"Help for source",
		);
	});

	it("opens the explanation on activation", async () => {
		render(InfoPopover, { props: { ...BASE, testId: "info-x" } });

		expect(screen.queryByText(BASE.body)).toBeNull();
		screen.getByTestId("info-x").click();
		await tick();

		expect(await screen.findByText(BASE.body)).toBeTruthy();
		expect(screen.getByText(BASE.title)).toBeTruthy();
	});

	it("shows the distinct reason band only when a reason is supplied", async () => {
		const { unmount } = render(InfoPopover, {
			props: { ...BASE, testId: "info-x" },
		});
		screen.getByTestId("info-x").click();
		await tick();
		expect(screen.queryByTestId("info-popover-reason")).toBeNull();
		unmount();

		render(InfoPopover, {
			props: {
				...BASE,
				reason: "Not supported on this platform",
				testId: "info-y",
			},
		});
		screen.getByTestId("info-y").click();
		await tick();

		const band = await screen.findByTestId("info-popover-reason");
		expect(
			within(band).getByText("Not supported on this platform"),
		).toBeTruthy();
	});
});
