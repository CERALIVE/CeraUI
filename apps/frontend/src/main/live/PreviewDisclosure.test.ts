// @vitest-environment jsdom
/**
 * PreviewDisclosure — the preview's default open state and the operator's stored
 * choice (Live screen contract, "The preview's open state").
 *
 *   • open by default at 768 px and wider, closed below that;
 *   • closed when `matchMedia` is unavailable;
 *   • a stored `ceraui.live.previewOpen` of `true`/`false` wins over the default,
 *     any other value counts as absent;
 *   • only the operator's own toggle is stored — the default is not.
 */
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/components/preview/PreviewCanvas.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("./PreviewEncodeControl.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));

import PreviewDisclosure from "./PreviewDisclosure.svelte";

const KEY = "ceraui.live.previewOpen";

/** A viewport of `width` px answering `(min-width: N px)` queries like a browser. */
function stubViewport(width: number): void {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string) => {
			const min = /min-width:\s*(\d+)px/.exec(query);
			return {
				matches: min !== null && width >= Number(min[1]),
				media: query,
				onchange: null,
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
				addListener: () => undefined,
				removeListener: () => undefined,
				dispatchEvent: () => false,
			};
		},
	});
}

function disclosure(container: HTMLElement): HTMLDetailsElement {
	const el = container.querySelector<HTMLDetailsElement>(
		'[data-testid="preview-disclosure"]',
	);
	if (el === null) throw new Error("preview-disclosure did not render");
	return el;
}

/** What a browser does when the operator taps the summary. */
function operatorToggle(el: HTMLDetailsElement): void {
	el.open = !el.open;
	el.dispatchEvent(new Event("toggle"));
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(window, "matchMedia");
	localStorage.clear();
});

describe("PreviewDisclosure — default open state", () => {
	it("is open by default at 1024 px", () => {
		stubViewport(1024);
		const { container } = render(PreviewDisclosure);
		expect(disclosure(container).open).toBe(true);
	});

	it("is open by default at exactly 768 px", () => {
		stubViewport(768);
		const { container } = render(PreviewDisclosure);
		expect(disclosure(container).open).toBe(true);
	});

	it("is closed by default at 375 px", () => {
		stubViewport(375);
		const { container } = render(PreviewDisclosure);
		expect(disclosure(container).open).toBe(false);
	});

	it("is closed when matchMedia is unavailable", () => {
		Reflect.deleteProperty(window, "matchMedia");
		const { container } = render(PreviewDisclosure);
		expect(disclosure(container).open).toBe(false);
	});
});

describe("PreviewDisclosure — the operator's stored choice", () => {
	it("a stored 'false' keeps it closed on a wide screen", () => {
		stubViewport(1280);
		localStorage.setItem(KEY, "false");
		const { container } = render(PreviewDisclosure);
		expect(disclosure(container).open).toBe(false);
	});

	it("a stored 'true' opens it on a phone", () => {
		stubViewport(375);
		localStorage.setItem(KEY, "true");
		const { container } = render(PreviewDisclosure);
		expect(disclosure(container).open).toBe(true);
	});

	it("any other stored value counts as absent", () => {
		stubViewport(375);
		localStorage.setItem(KEY, "1");
		const { container } = render(PreviewDisclosure);
		expect(disclosure(container).open).toBe(false);
	});

	it("stores each operator toggle, never the default", () => {
		stubViewport(1024);
		const { container } = render(PreviewDisclosure);
		const el = disclosure(container);

		// The browser fires `toggle` once for the default it rendered with: that is
		// not a choice, so nothing is stored.
		el.dispatchEvent(new Event("toggle"));
		expect(localStorage.getItem(KEY)).toBeNull();

		operatorToggle(el);
		expect(el.open).toBe(false);
		expect(localStorage.getItem(KEY)).toBe("false");

		operatorToggle(el);
		expect(el.open).toBe(true);
		expect(localStorage.getItem(KEY)).toBe("true");
	});

	it("the stored choice survives a remount", () => {
		stubViewport(1024);
		const first = render(PreviewDisclosure);
		operatorToggle(disclosure(first.container));
		first.unmount();

		const { container } = render(PreviewDisclosure);
		expect(disclosure(container).open).toBe(false);
	});
});
