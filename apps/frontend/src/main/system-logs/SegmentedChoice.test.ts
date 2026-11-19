// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import SegmentedChoice from "./SegmentedChoice.svelte";

const OPTIONS = [
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta" },
	{ value: "c", label: "Gamma" },
] as const;

function show(value: "a" | "b" | "c" = "b", dir?: "rtl") {
	const onSelect = vi.fn();
	if (dir) document.documentElement.setAttribute("dir", dir);
	render(SegmentedChoice, {
		label: "Letters",
		options: OPTIONS,
		value,
		onSelect,
		testid: "letters",
		class: "w-full",
	});
	return onSelect;
}

const radio = (name: string) => screen.getByRole("radio", { name });

afterEach(() => {
	cleanup();
	document.documentElement.removeAttribute("dir");
});

describe("SegmentedChoice", () => {
	it("is one named radio group of equal segments with the value checked", () => {
		show();
		const group = screen.getByRole("radiogroup", { name: "Letters" });
		expect(group.dataset.testid).toBe("letters");
		expect(group.getAttribute("tabindex")).toBe("-1");
		expect(group.className).toContain("w-full");
		expect(group.className).toContain("auto-cols-[minmax(min-content,1fr)]");
		expect(group.className).toContain("grid-flow-col");
		expect(radio("Beta").getAttribute("aria-checked")).toBe("true");
		expect(radio("Alpha").getAttribute("aria-checked")).toBe("false");
		expect(radio("Beta").dataset.value).toBe("b");
	});

	it("is a single tab stop on the checked segment", () => {
		show();
		expect(radio("Beta").tabIndex).toBe(0);
		expect(radio("Alpha").tabIndex).toBe(-1);
		expect(radio("Gamma").tabIndex).toBe(-1);
	});

	it("raises the checked segment above its track in dark, where the background token is darker than the track", () => {
		show();
		expect(radio("Alpha").className.split(/\s+/)).toContain(
			"dark:aria-checked:bg-accent",
		);
	});

	it("styles the checked segment tonally and keeps touch targets", () => {
		show();
		const segment = radio("Alpha");
		expect(segment.className).toContain("aria-checked:bg-background");
		expect(segment.className).toContain("aria-checked:text-foreground");
		expect(segment.className).toContain(
			"min-h-[max(2rem,var(--touch-target-min))]",
		);
		expect(segment.className).toContain("min-w-(--touch-target-min)");
		expect(segment.className).toContain("whitespace-normal");
		expect(segment.className).toContain("px-2");
		expect(segment.className).not.toContain("px-2.5");
		expect(segment.className).not.toContain("primary");
		expect(segment.getAttribute("type")).toBe("button");
	});

	it("selects another segment on click and ignores the checked one", async () => {
		const onSelect = show();
		await fireEvent.click(radio("Gamma"));
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("c");
		await fireEvent.click(radio("Beta"));
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it.each([
		["ArrowRight", "c"],
		["ArrowDown", "c"],
		["ArrowLeft", "a"],
		["ArrowUp", "a"],
		["Home", "a"],
		["End", "c"],
	] as const)("moves the choice with %s", async (key, value) => {
		const onSelect = show();
		await fireEvent.keyDown(radio("Beta"), { key });
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(value);
	});

	it("wraps around at both ends", async () => {
		const first = show("c");
		await fireEvent.keyDown(radio("Gamma"), { key: "ArrowRight" });
		expect(first).toHaveBeenCalledExactlyOnceWith("a");
		cleanup();
		const last = show("a");
		await fireEvent.keyDown(radio("Alpha"), { key: "ArrowLeft" });
		expect(last).toHaveBeenCalledExactlyOnceWith("c");
	});

	it("follows the reading direction for horizontal arrows in RTL", async () => {
		const onSelect = show("b", "rtl");
		await fireEvent.keyDown(radio("Beta"), { key: "ArrowLeft" });
		expect(onSelect).toHaveBeenLastCalledWith("c");
		await fireEvent.keyDown(radio("Beta"), { key: "ArrowRight" });
		expect(onSelect).toHaveBeenLastCalledWith("a");
		await fireEvent.keyDown(radio("Beta"), { key: "ArrowDown" });
		expect(onSelect).toHaveBeenLastCalledWith("c");
	});

	it("moves focus to the segment it chose and lets other keys through", async () => {
		show();
		const event = new KeyboardEvent("keydown", {
			key: "End",
			bubbles: true,
			cancelable: true,
		});
		radio("Beta").dispatchEvent(event);
		await tick();
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(radio("Gamma"));
		const other = new KeyboardEvent("keydown", {
			key: "Tab",
			bubbles: true,
			cancelable: true,
		});
		radio("Beta").dispatchEvent(other);
		expect(other.defaultPrevented).toBe(false);
	});
});
