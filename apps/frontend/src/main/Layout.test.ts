// @vitest-environment jsdom
/**
 * Layout.svelte — auth-check timeout lifecycle (Todo 3).
 *
 * The stored-token auth check is guarded by two timers that used to be bare
 * `setTimeout`s: they mutated `isCheckingAuthStatus` with no cleanup and silently
 * dropped the UI to a blank/auth screen. They are now wrapped in `$effect` (timer
 * cleared on unmount, re-armed on retry) and, on expiry, surface an explicit
 * `authTimedOut` state — a calm `role="status"` retry band instead of a blank
 * screen.
 *
 * These tests drive the REAL Layout with the heavy child views/dialogs replaced
 * by inert Noop stubs and the store graph mocked, so only the timer/timeout UI is
 * exercised. `sendAuthMessage` is mocked to NEVER resolve (simulating an offline
 * device / dropped socket), so the check stalls and the timeout path runs.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import Layout from "./Layout.svelte";

// --- Heavy children replaced by an inert stub (each pulls a subscription graph
//     we do not need to exercise the auth-timeout surface). -------------------
const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("./Auth.svelte", noop);
vi.mock("./DisconnectedBanner.svelte", noop);
vi.mock("./MainView.svelte", noop);
vi.mock("./layout/LayoutToastHost.svelte", noop);
vi.mock("./layout/UpdateBanner.svelte", noop);
vi.mock("$lib/components/updating-overlay.svelte", noop);

// The pwa barrel exports two named components — stub both with the Noop.
vi.mock("$lib/components/custom/pwa", async () => {
	const Noop = (await import("../tests/fixtures/Noop.svelte")).default;
	return { OfflinePage: Noop, PWAStatus: Noop };
});

const sendAuthMessage = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({ auth: undefined as unknown, status: false as unknown }));

vi.mock("$lib/stores/websocket-store.svelte", () => ({
	getAuth: () => authState.auth,
	getStatus: () => authState.status,
	sendAuthMessage,
}));

vi.mock("$lib/stores/offline-state.svelte", () => ({
	getShouldShowOfflinePage: () => false,
}));

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	markAuthenticated: vi.fn(),
	clearSessionExpired: vi.fn(),
	markSessionExpired: vi.fn(),
	shouldExpireSession: () => false,
	wasAuthenticated: () => false,
}));

vi.mock("$lib/stores/auth-status.svelte", () => ({
	authStatusStore: {
		get value() {
			return false;
		},
		set: vi.fn(),
		subscribe: (cb: (v: boolean) => void) => {
			cb(false);
			return () => {};
		},
	},
}));

// Non-mobile, non-PWA host → the primary auth timeout is 3000ms and the
// mobile/PWA fallback effect never arms its timer.
beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
});

beforeEach(() => {
	vi.useFakeTimers();
	sendAuthMessage.mockReset();
	authState.auth = undefined;
	authState.status = false;
	// A stored token makes the component run the auth-check branch; the mocked
	// sendAuthMessage never invokes its callback, so the check stalls.
	localStorage.setItem("auth", "token-abc");
});

afterEach(() => {
	vi.useRealTimers();
	localStorage.clear();
});

describe("Layout — auth-check timeout surface", () => {
	it("renders the calm retry band on timeout and re-runs the check on retry", async () => {
		render(Layout);

		// Kicked off the stalled check; still loading, no timeout band yet.
		expect(sendAuthMessage).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("auth-timeout")).toBeNull();

		// Primary auth timeout (3000ms) elapses → explicit timed-out state.
		await vi.advanceTimersByTimeAsync(3000);
		await tick();

		const band = await screen.findByTestId("auth-timeout");
		expect(band.getAttribute("role")).toBe("status");
		const retry = band.querySelector("button");
		expect(retry).not.toBeNull();

		// Retry re-runs the auth check and dismisses the timed-out surface.
		await fireEvent.click(retry as HTMLButtonElement);
		await tick();
		expect(sendAuthMessage).toHaveBeenCalledTimes(2);
		await waitFor(() =>
			expect(screen.queryByTestId("auth-timeout")).toBeNull(),
		);
	});

	it("clears the pending timer on unmount — no post-unmount state mutation", async () => {
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");

		const { unmount } = render(Layout);
		expect(screen.queryByTestId("auth-timeout")).toBeNull();

		// Unmount BEFORE the timeout fires → the $effect cleanup must clear it.
		unmount();
		expect(clearSpy).toHaveBeenCalled();

		// Advancing past the timeout must not resurrect the band (timer cleared,
		// no state mutation on the torn-down component).
		await vi.advanceTimersByTimeAsync(3000);
		await tick();
		expect(screen.queryByTestId("auth-timeout")).toBeNull();

		clearSpy.mockRestore();
	});
});
