// @vitest-environment jsdom
/**
 * DevTools mobile capture: the phone-sized frame copies the whole app shell
 * (skip link, header, HUD, the destination's main landmark and the dock), not
 * the main landmark alone, which holds only the destination content.
 */
import { afterEach, describe, expect, it } from "vitest";

import { mobileCaptureRoot } from "./screenshot.svelte";

afterEach(() => {
	document.body.innerHTML = "";
});

describe("mobileCaptureRoot", () => {
	it("brings the shell chrome along with the destination", () => {
		document.body.innerHTML = `
			<div id="app"><div>
				<a href="#main-content">Skip to main content</a>
				<header>CeraUI</header>
				<div data-hud-region>HUD</div>
				<main id="main-content" tabindex="-1">Live</main>
				<nav aria-label="Destinations">Dock</nav>
			</div></div>`;

		const root = mobileCaptureRoot(document);
		expect(root).toBe(document.getElementById("app"));
		expect(root).toBeInstanceOf(HTMLElement);

		for (const part of [
			'a[href="#main-content"]',
			"header",
			"[data-hud-region]",
			"#main-content",
			"nav",
		]) {
			expect(root?.querySelector(part), part).toBeInstanceOf(Element);
		}
	});
});
