// @vitest-environment jsdom
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import Layout from "./Layout.svelte";

const heartbeat = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const noop = vi.hoisted(() => async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/rpc", () => ({ rpc: { ui: { heartbeat } } }));
vi.mock("./Auth.svelte", noop);
vi.mock("./DisconnectedBanner.svelte", noop);
vi.mock("./MainView.svelte", noop);
vi.mock("./layout/LayoutToastHost.svelte", noop);
vi.mock("./layout/UpdateBanner.svelte", noop);
vi.mock("$lib/components/updating-overlay.svelte", noop);
vi.mock("$lib/components/custom/pwa", async () => ({
	OfflinePage: (await import("../tests/fixtures/Noop.svelte")).default,
	PWAStatus: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => undefined,
}));
vi.mock("$lib/stores/offline-state.svelte", () => ({
	getShouldShowOfflinePage: () => false,
}));
vi.mock("$lib/stores/connection-ux.svelte", () => ({
	deriveConnectionSurfaceUx: () => ({ showAuthTimeout: false }),
	getDisconnectedSince: () => null,
	getGraceNow: () => 0,
}));
vi.mock("$lib/stores/auth-status.svelte", () => ({
	authenticateWithToken: vi.fn(),
	revokePersistentToken: vi.fn(),
	authStatusStore: {
		get value() {
			return true;
		},
		set: vi.fn(),
	},
}));

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false }));
});
beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	heartbeat.mockClear();
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test("authenticated foreground layout heartbeats every 30 seconds and stops while hidden or unfocused", async () => {
	const view = render(Layout);
	await tick();
	expect(heartbeat).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(29_999);
	expect(heartbeat).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(1);
	expect(heartbeat).toHaveBeenCalledTimes(2);
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "hidden",
	});
	vi.advanceTimersByTime(30_000);
	expect(heartbeat).toHaveBeenCalledTimes(2);
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
	vi.mocked(document.hasFocus).mockReturnValue(false);
	vi.advanceTimersByTime(30_000);
	expect(heartbeat).toHaveBeenCalledTimes(2);
	vi.mocked(document.hasFocus).mockReturnValue(true);
	window.dispatchEvent(new Event("focus"));
	expect(heartbeat).toHaveBeenCalledTimes(3);
	view.unmount();
	vi.advanceTimersByTime(30_000);
	expect(heartbeat).toHaveBeenCalledTimes(3);
});
