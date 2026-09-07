// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthAttempt } from "../lib/stores/auth-status.svelte";

import Layout from "./Layout.svelte";

const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);

vi.mock("./Auth.svelte", async () => ({
	default: (await import("../tests/fixtures/AuthStub.svelte")).default,
}));
vi.mock("./DisconnectedBanner.svelte", noop);
vi.mock("./MainView.svelte", noop);
vi.mock("./layout/LayoutToastHost.svelte", noop);
vi.mock("./layout/UpdateBanner.svelte", noop);
vi.mock("$lib/components/updating-overlay.svelte", noop);
vi.mock("$lib/components/custom/pwa", async () => {
	const Noop = (await import("../tests/fixtures/Noop.svelte")).default;
	return { OfflinePage: Noop, PWAStatus: Noop };
});

const authState = vi.hoisted(() => ({
	attempt: { kind: "unreachable", cause: "rpc-error" } as AuthAttempt,
	status: false,
}));
const authenticateWithToken = vi.hoisted(() =>
	vi.fn(async () => authState.attempt),
);
const revokePersistentToken = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => undefined,
}));
vi.mock("$lib/stores/offline-state.svelte", () => ({
	getShouldShowOfflinePage: () => false,
}));
vi.mock("$lib/stores/connection-ux.svelte", () => ({
	deriveConnectionSurfaceUx: (input: { authTimedOut: boolean }) => ({
		showOfflineBanner: true,
		showAuthTimeout: input.authTimedOut,
	}),
	getDisconnectedSince: () => 0,
	getGraceNow: () => 3000,
	markAuthenticated: vi.fn(),
	clearSessionExpired: vi.fn(),
	markSessionExpired: vi.fn(),
	shouldExpireSession: () => false,
	wasAuthenticated: () => false,
}));
vi.mock("$lib/stores/auth-status.svelte", () => ({
	authenticateWithToken,
	revokePersistentToken,
	getAuthMessage: () => undefined,
	authStatusStore: {
		get value() {
			return authState.status;
		},
		set: (value: boolean) => {
			authState.status = value;
		},
		subscribe: (callback: (value: boolean) => void) => {
			callback(authState.status);
			return () => {};
		},
	},
}));

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
	authenticateWithToken.mockClear();
	revokePersistentToken.mockClear();
	authState.status = false;
	localStorage.clear();
	localStorage.setItem("auth", "saved-issued-token");
});

describe("Layout — saved credential auth result", () => {
	it("deletes the saved credential exactly once when the server rejects it", async () => {
		authState.attempt = { kind: "rejected" };
		const removeItem = vi.spyOn(localStorage, "removeItem");

		render(Layout);

		await waitFor(() =>
			expect(removeItem).toHaveBeenCalledExactlyOnceWith("auth"),
		);
		expect(localStorage.getItem("auth")).toBeNull();
		expect(authenticateWithToken).toHaveBeenCalledExactlyOnceWith(
			"saved-issued-token",
		);
		removeItem.mockRestore();
	});

	it.each(["socket-not-ready", "rpc-error", "timeout"] as const)(
		"keeps the saved credential and shows recovery when auth is unreachable: %s",
		async (cause) => {
			authState.attempt = { kind: "unreachable", cause };
			const removeItem = vi.spyOn(localStorage, "removeItem");

			render(Layout);

			await screen.findByTestId("auth-timeout");
			expect(removeItem).not.toHaveBeenCalled();
			expect(localStorage.getItem("auth")).toBe("saved-issued-token");
			expect(authenticateWithToken).toHaveBeenCalledExactlyOnceWith(
				"saved-issued-token",
			);
			removeItem.mockRestore();
		},
	);

	it("explicitly clearing an unreachable session also attempts device revocation", async () => {
		authState.attempt = { kind: "unreachable", cause: "rpc-error" };
		render(Layout);
		await screen.findByTestId("auth-timeout");

		await fireEvent.click(screen.getByTestId("clear-saved-session"));

		expect(localStorage.getItem("auth")).toBeNull();
		expect(revokePersistentToken).toHaveBeenCalledExactlyOnceWith(
			"saved-issued-token",
		);
	});
});
