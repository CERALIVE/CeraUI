// @vitest-environment jsdom
/**
 * LiveBar — the fixed bar that carries the screen's one action.
 *
 *   • it renders its status line (idle readiness) and the action it hosts;
 *   • while mounted it publishes its height as `--live-bar-height` on the
 *     document root, so page content and the toast stack can clear it, and it
 *     removes the property when it unmounts.
 */
import { cleanup, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import LiveBar from "./LiveBar.svelte";

const action = createRawSnippet(() => ({
	render: () => '<button type="button">Start Stream</button>',
}));

const realResizeObserver = window.ResizeObserver;

beforeEach(() => {
	// Report a 72 px bar the moment it is observed, as a browser does on observe().
	window.ResizeObserver = class {
		readonly #callback: ResizeObserverCallback;
		constructor(callback: ResizeObserverCallback) {
			this.#callback = callback;
		}
		observe(target: Element): void {
			Object.defineProperty(target, "offsetHeight", {
				configurable: true,
				value: 72,
			});
			this.#callback([], this as unknown as ResizeObserver);
		}
		unobserve(): void {}
		disconnect(): void {}
	} as unknown as typeof ResizeObserver;
});

afterEach(() => {
	cleanup();
	window.ResizeObserver = realResizeObserver;
	document.documentElement.style.removeProperty("--live-bar-height");
});

describe("LiveBar", () => {
	it("shows the status line beside the action it hosts", () => {
		const { getByTestId } = render(LiveBar, {
			props: { status: "Select a source", blocked: true, children: action },
		});
		const bar = getByTestId("live-bar");
		expect(bar.textContent).toContain("Select a source");
		expect(bar.querySelector("button")?.textContent).toBe("Start Stream");
		expect(bar.getAttribute("data-state")).toBe("blocked");
	});

	it("publishes its height on the document root while mounted", () => {
		const { unmount } = render(LiveBar, { props: { children: action } });
		expect(
			document.documentElement.style.getPropertyValue("--live-bar-height"),
		).toBe("72px");

		unmount();
		expect(
			document.documentElement.style.getPropertyValue("--live-bar-height"),
		).toBe("");
	});
});
