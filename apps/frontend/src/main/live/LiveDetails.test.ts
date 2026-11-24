// @vitest-environment jsdom

import { setLocale } from "@ceraui/i18n/svelte";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { es } from "../../tests/helpers/catalog";
import LiveDetails from "./LiveDetails.svelte";

describe("LiveDetails", () => {
	const body = createRawSnippet(() => ({
		render: () => "<p data-probe>engine numbers</p>",
	}));
	let query: EventTarget & { matches: boolean };

	beforeEach(() => {
		localStorage.clear();
		query = Object.assign(new EventTarget(), { matches: false });
		vi.stubGlobal("matchMedia", () => query);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	function details(container: HTMLElement): HTMLDetailsElement {
		const element = container.querySelector("details");
		if (!element) throw new Error("Details disclosure did not render");
		return element;
	}

	it("starts folded on a phone, with its content still mounted", () => {
		const { container } = render(LiveDetails, { props: { children: body } });
		expect(details(container).open).toBe(false);
		expect(container.querySelector("[data-probe]")).not.toBeNull();
	});

	it.each([
		{ externalState: "opened", externallyOpen: true, expectedOpen: false },
		{ externalState: "closed", externallyOpen: false, expectedOpen: true },
	])(
		"toggles the visible disclosure after it was $externalState externally",
		async ({ externallyOpen, expectedOpen }) => {
			const preferenceKey = "ceraui.live.detailsOpen";
			localStorage.setItem(preferenceKey, String(expectedOpen));
			const { container } = render(LiveDetails, { props: { children: body } });
			const disclosure = details(container);
			const summary = disclosure.querySelector("summary");
			if (!summary) throw new Error("Details summary did not render");

			// Model a browser Find reveal or a direct DOM write, not an activation.
			disclosure.open = externallyOpen;
			await fireEvent(disclosure, new Event("toggle"));
			expect(disclosure.open).toBe(externallyOpen);
			expect(localStorage.getItem(preferenceKey)).toBe(String(expectedOpen));

			await fireEvent.click(summary);
			await fireEvent(disclosure, new Event("toggle"));

			expect({
				open: disclosure.open,
				saved: localStorage.getItem(preferenceKey),
			}).toEqual({ open: expectedOpen, saved: String(expectedOpen) });
		},
	);

	it.each([
		{ choice: "open", initiallyOpen: false, expectedOpen: true },
		{ choice: "folded", initiallyOpen: true, expectedOpen: false },
	])(
		"keeps the streamer's $choice choice when width changes before toggle delivery",
		async ({ initiallyOpen, expectedOpen }) => {
			localStorage.setItem("ceraui.live.detailsOpen", String(initiallyOpen));
			const { container } = render(LiveDetails, { props: { children: body } });
			const disclosure = details(container);
			const summary = disclosure.querySelector("summary");
			if (!summary) throw new Error("Details summary did not render");
			const held = (event: Event) => event.stopImmediatePropagation();
			disclosure.addEventListener("toggle", held, { capture: true });

			await fireEvent.click(summary);
			expect(disclosure.open).toBe(expectedOpen);
			query.matches = true;
			query.dispatchEvent(new Event("change"));
			await tick();
			expect(disclosure.open).toBe(true);

			disclosure.removeEventListener("toggle", held, { capture: true });
			await fireEvent(disclosure, new Event("toggle"));
			query.matches = false;
			query.dispatchEvent(new Event("change"));
			await tick();

			expect(disclosure.open).toBe(expectedOpen);
			expect(localStorage.getItem("ceraui.live.detailsOpen")).toBe(
				String(expectedOpen),
			);
			cleanup();
			const again = render(LiveDetails, { props: { children: body } });
			expect(details(again.container).open).toBe(expectedOpen);
		},
	);

	it("is open on a desktop-width screen whatever was stored", () => {
		localStorage.setItem("ceraui.live.detailsOpen", "false");
		query.matches = true;
		const { container } = render(LiveDetails, { props: { children: body } });
		expect(details(container).open).toBe(true);
	});

	it("is forced open in the post-stream summary", () => {
		localStorage.setItem("ceraui.live.detailsOpen", "false");
		const { container } = render(LiveDetails, {
			props: { children: body, forceOpen: true },
		});
		expect(details(container).open).toBe(true);
	});

	it("cannot be folded while forced open, and the stored choice applies again after", async () => {
		localStorage.setItem("ceraui.live.detailsOpen", "false");
		const { container, rerender } = render(LiveDetails, {
			props: { children: body, forceOpen: true },
		});
		let visibility: string | undefined;
		const summary = container.querySelector("summary");
		if (summary) visibility = getComputedStyle(summary).display;
		expect(visibility).toBe("none");
		// Closing it some other way is undone while forced open.
		details(container).open = false;
		await fireEvent(details(container), new Event("toggle"));
		expect(details(container).open).toBe(true);
		expect(localStorage.getItem("ceraui.live.detailsOpen")).toBe("false");
		await rerender({ forceOpen: false });
		expect(details(container).open).toBe(false);
	});

	it("does not overwrite the phone's folded preference while wide", () => {
		localStorage.setItem("ceraui.live.detailsOpen", "false");
		query.matches = true;
		const first = render(LiveDetails, { props: { children: body } });
		expect(details(first.container).open).toBe(true);
		cleanup();
		query.matches = false;
		const second = render(LiveDetails, { props: { children: body } });
		expect(details(second.container).open).toBe(false);
	});

	it("renders localized Details copy that names what is inside", () => {
		setLocale("es");
		try {
			render(LiveDetails, { props: { children: body } });
			expect(screen.getByText(es.live.glance.details)).toBeDefined();
			expect(screen.getByText(es.live.glance.detailsHint)).toBeDefined();
		} finally {
			setLocale("en");
		}
	});
});
