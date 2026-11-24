import { afterEach, describe, expect, it, vi } from "vitest";

import { publishHeight } from "./layout";

/** A ResizeObserver stand-in that lets the test deliver one border-box size. */
function stubResizeObserver() {
	const observed: { box?: ResizeObserverBoxOptions }[] = [];
	let deliver: (blockSize: number) => void = () => {};
	const disconnect = vi.fn();
	class Stub {
		constructor(callback: ResizeObserverCallback) {
			deliver = (blockSize) =>
				callback(
					[
						{
							borderBoxSize: [{ blockSize, inlineSize: 0 }],
						} as unknown as ResizeObserverEntry,
					],
					this as never,
				);
		}
		observe(_target: Element, options?: ResizeObserverOptions) {
			observed.push({ box: options?.box });
		}
		disconnect = disconnect;
		unobserve() {}
	}
	vi.stubGlobal("ResizeObserver", Stub);
	return {
		observed,
		deliver: (blockSize: number) => deliver(blockSize),
		disconnect,
	};
}

describe("publishHeight", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		document.documentElement.removeAttribute("style");
	});

	it("rounds a fractional height up, so a neighbour resting on its edge never overlaps it", () => {
		const resize = stubResizeObserver();
		publishHeight(document.createElement("div"), "--bar-height");
		resize.deliver(123.1875);
		expect(
			document.documentElement.style.getPropertyValue("--bar-height"),
		).toBe("124px");
		resize.deliver(57);
		expect(
			document.documentElement.style.getPropertyValue("--bar-height"),
		).toBe("57px");
	});

	it("measures the border box, so padding and border count too", () => {
		const resize = stubResizeObserver();
		publishHeight(document.createElement("div"), "--bar-height");
		expect(resize.observed).toEqual([{ box: "border-box" }]);
	});

	it("removes the property and stops observing on cleanup", () => {
		const resize = stubResizeObserver();
		const cleanup = publishHeight(
			document.createElement("div"),
			"--bar-height",
		);
		resize.deliver(40.5);
		cleanup?.();
		expect(
			document.documentElement.style.getPropertyValue("--bar-height"),
		).toBe("");
		expect(resize.disconnect).toHaveBeenCalledOnce();
	});
});
