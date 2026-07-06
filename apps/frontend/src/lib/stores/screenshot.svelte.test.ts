/**
 * DevTools screenshot utility — capture-list derivation + ZIP folder mapping.
 *
 * The capture list is derived at RUNTIME from `navElements` (the same source
 * `MainView`/`SettingsView` navigation uses) so it can never drift from the real
 * 3-destination navigation again. Dev-only entries (`devtools`, `identity` — both
 * carry `isDev: true`) are excluded; the result under any build shape must be
 * exactly `['live', 'network', 'settings']`.
 *
 * Both functions under test are pure and rune-free, so they run under the plain
 * vitest environment without evaluating the store's runes. `screenshot.svelte.ts`
 * imports `NavElements` as a type-only import, so requiring it here never pulls
 * the `$lib/config` view graph.
 */
import { describe, expect, it } from "vitest";

import type { NavElements } from "../config";
import {
	deriveCaptureKeys,
	REQUIRED_CAPTURE_DESTINATIONS,
	type ScreenshotImage,
	zipFolderForImage,
} from "./screenshot.svelte";

// Minimal NavElement stand-in — deriveCaptureKeys only reads `.isDev`.
function navEl(isDev = false): NavElements[string] {
	return { label: "x", component: null as never, ...(isDev ? { isDev } : {}) };
}

// Dev-shaped navElements: the 3 primary destinations PLUS the two dev-only
// entries Vite injects in dev builds (src/lib/config/index.ts).
const devShapedNavElements: NavElements = {
	live: navEl(),
	network: navEl(),
	settings: navEl(),
	identity: navEl(true),
	devtools: navEl(true),
};

// Prod-shaped navElements: only the 3 primary destinations.
const prodShapedNavElements: NavElements = {
	live: navEl(),
	network: navEl(),
	settings: navEl(),
};

describe("deriveCaptureKeys", () => {
	it("derives exactly the 3 destinations from a dev-shaped navElements, excluding devtools + identity", () => {
		expect(deriveCaptureKeys(devShapedNavElements)).toEqual([
			"live",
			"network",
			"settings",
		]);
	});

	it("derives the same 3 destinations from a prod-shaped navElements", () => {
		expect(deriveCaptureKeys(prodShapedNavElements)).toEqual([
			"live",
			"network",
			"settings",
		]);
	});

	it("matches the REQUIRED_CAPTURE_DESTINATIONS contract", () => {
		expect(REQUIRED_CAPTURE_DESTINATIONS).toEqual([
			"live",
			"network",
			"settings",
		]);
	});

	it("surfaces an error (drift guard) when navElements is missing 'live' instead of silently capturing fewer destinations", () => {
		const drifted: NavElements = {
			network: navEl(),
			settings: navEl(),
		};
		expect(() => deriveCaptureKeys(drifted)).toThrow(/live/);
	});

	it("surfaces an error when navElements is missing 'settings'", () => {
		const drifted: NavElements = {
			live: navEl(),
			network: navEl(),
		};
		expect(() => deriveCaptureKeys(drifted)).toThrow(/settings/);
	});
});

describe("zipFolderForImage", () => {
	function img(
		type: ScreenshotImage["type"],
		theme: ScreenshotImage["theme"],
	): ScreenshotImage {
		return { filename: "live.png", blob: new Blob(), theme, type };
	}

	it("maps desktop images to desktop/<theme>/", () => {
		expect(zipFolderForImage(img("desktop", "dark"))).toBe("desktop/dark/");
		expect(zipFolderForImage(img("desktop", "light"))).toBe("desktop/light/");
	});

	it("maps mobile images to mobile/<theme>/", () => {
		expect(zipFolderForImage(img("mobile", "dark"))).toBe("mobile/dark/");
		expect(zipFolderForImage(img("mobile", "light"))).toBe("mobile/light/");
	});

	it("maps offline images to features/", () => {
		expect(zipFolderForImage(img("offline", "dark"))).toBe("features/");
		expect(zipFolderForImage(img("offline", "light"))).toBe("features/");
	});
});
