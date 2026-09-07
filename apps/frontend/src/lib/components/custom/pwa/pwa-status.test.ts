// @vitest-environment jsdom
/**
 * pwa-status.svelte — behaviour lock for the two banners.
 *
 * The install banner was computed by an `$effect` that mirrored four
 * non-reactive probes (touch/UA/standalone/dismissed) into a `$state` slot, and
 * the probes themselves were FUNCTION-valued `$derived`s re-evaluated on every
 * render. These cases pin what an operator actually sees across that refactor:
 *
 *   · a mobile browser that is not already installed gets the install banner;
 *   · an installed (standalone) launch and a desktop browser get none;
 *   · dismissing it withdraws it AND tells the PWA store;
 *   · the offline band follows the ONE shared reconnect-grace verdict.
 *
 * Green on the pre-change tree — refactor lock, not a bug fix. Copy is compared
 * against the catalog rather than hardcoded, so a translation change cannot
 * silently pass and this file can never become the copy's source of truth.
 */
import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PwaStatus from "./pwa-status.svelte";

const surface = vi.hoisted(() => ({ showOfflineBanner: false }));
const setShowIOSInstallPrompt = vi.hoisted(() => vi.fn());
const installApp = vi.hoisted(() => vi.fn());

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	deriveConnectionSurfaceUx: () => ({
		showOfflineBanner: surface.showOfflineBanner,
	}),
	getDisconnectedSince: () => null,
	getGraceNow: () => 0,
}));

vi.mock("$lib/stores/pwa.svelte", () => ({
	getCanInstall: () => false,
	installApp,
	setShowIOSInstallPrompt,
}));

vi.mock("$lib/stores/notifications.svelte", () => ({ push: vi.fn() }));

const IPHONE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const DESKTOP_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

function setUserAgent(value: string): void {
	Object.defineProperty(window.navigator, "userAgent", {
		value,
		configurable: true,
	});
}

function setStandalone(matches: boolean): void {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: query.includes("display-mode: standalone") ? matches : false,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
}

const installBanner = () => screen.queryByText(m["pwa.installTitle"]());
const offlineBanner = () => screen.queryByText(m["pwa.offline"]());

beforeEach(() => {
	surface.showOfflineBanner = false;
	setUserAgent(DESKTOP_UA);
	setStandalone(false);
	setShowIOSInstallPrompt.mockReset();
	installApp.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("pwa-status — the install banner", () => {
	it("shows on a mobile browser that is not already installed", () => {
		setUserAgent(IPHONE_UA);
		render(PwaStatus);
		expect(installBanner()).not.toBeNull();
	});

	it("stays away on a standalone (already-installed) launch", () => {
		setUserAgent(IPHONE_UA);
		setStandalone(true);
		render(PwaStatus);
		expect(installBanner()).toBeNull();
	});

	// NOTE: there is deliberately no "desktop browser" leg. jsdom's Window
	// implements `ontouchstart`, so `'ontouchstart' in window` is TRUE in this
	// environment whatever the user agent says, and the component's non-touch
	// branch is structurally unreachable here. Pinning that artifact would
	// document jsdom, not the component; the standalone leg above already
	// covers "no install banner".

	it("is withdrawn by the dismiss control, which also tells the store", async () => {
		setUserAgent(IPHONE_UA);
		render(PwaStatus);
		expect(installBanner()).not.toBeNull();

		const dismiss = screen.getByRole("button", {
			name: m["pwa.installIosGotIt"](),
		});
		await fireEvent.click(dismiss);

		expect(installBanner()).toBeNull();
		expect(setShowIOSInstallPrompt).toHaveBeenCalledWith(false);
	});

	it("carries the iOS instruction copy on an iOS user agent", () => {
		setUserAgent(IPHONE_UA);
		render(PwaStatus);
		expect(
			screen.queryByText(m["pwa.installIosDescription"](), { exact: false }),
		).not.toBeNull();
	});
});

describe("pwa-status — the offline band", () => {
	it("renders only when the shared grace verdict says so", () => {
		const first = render(PwaStatus);
		expect(offlineBanner()).toBeNull();
		first.unmount();

		surface.showOfflineBanner = true;
		render(PwaStatus);
		expect(offlineBanner()).not.toBeNull();
	});

	it("is gated independently of the install banner", () => {
		surface.showOfflineBanner = true;
		setUserAgent(IPHONE_UA);
		setStandalone(true);
		render(PwaStatus);
		expect(offlineBanner()).not.toBeNull();
		expect(installBanner()).toBeNull();
	});
});
