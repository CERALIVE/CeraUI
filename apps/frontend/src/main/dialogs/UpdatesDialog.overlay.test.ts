// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	initSubscriptions,
	resetState,
} from "../../lib/rpc/subscriptions.svelte.ts";
import Layout from "../Layout.svelte";
import UpdatesDialog from "./UpdatesDialog.svelte";

const transport = vi.hoisted(() => {
	const state: {
		message?: (type: string, data: unknown, seq?: number) => void;
	} = {};
	return state;
});
const noop = vi.hoisted(() => async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("../Auth.svelte", noop);
vi.mock("../DisconnectedBanner.svelte", noop);
vi.mock("../MainView.svelte", noop);
vi.mock("../layout/LayoutToastHost.svelte", noop);
vi.mock("../layout/UpdateBanner.svelte", noop);
vi.mock("$lib/components/custom/pwa", async () => {
	const Noop = (await import("../../tests/fixtures/Noop.svelte")).default;
	return { OfflinePage: Noop, PWAStatus: Noop };
});
vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: { login: async () => ({ success: true }) },
		streaming: { getConfig: async () => ({}) },
		status: { getStatus: async () => ({}) },
	},
	rpcClient: {
		onMessage: (fn: (type: string, data: unknown, seq?: number) => void) => {
			transport.message = fn;
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		isConnected: () => true,
		getSocket: () => undefined,
		sendLegacy: () => {},
	},
}));
vi.mock("$lib/stores/offline-state.svelte", () => ({
	getShouldShowOfflinePage: () => false,
}));
vi.mock("$lib/stores/connection-ux.svelte", () => ({
	deriveConnectionSurfaceUx: () => ({
		showOfflineBanner: false,
		showAuthTimeout: false,
	}),
	getDisconnectedSince: () => null,
	getGraceNow: () => 0,
	markAuthenticated: () => {},
	clearSessionExpired: () => {},
	markSessionExpired: () => {},
	shouldExpireSession: () => false,
	wasAuthenticated: () => true,
}));
vi.mock("$lib/stores/auth-status.svelte", () => ({
	authenticate: async () => ({ kind: "ok" }),
	getAuthMessage: () => ({ success: true }),
	authStatusStore: {
		value: true,
		set: () => {},
		subscribe: (fn: (value: boolean) => void) => {
			fn(true);
			return () => {};
		},
	},
}));

beforeEach(() => {
	resetState();
	initSubscriptions();
});
afterEach(() => {
	cleanup();
	resetState();
});

it("retracts the global overlay on the atomic refusal and preserves that clear on later omission", async () => {
	// Given the real subscription store and global Layout with an update in progress.
	const progress = { total: 1, downloading: 0, unpacking: 0, setting_up: 0 };
	transport.message?.("status", {
		updating: progress,
		update_state: { kind: "downloading", progress },
	});
	render(Layout);
	render(UpdatesDialog, { open: true });
	await waitFor(() =>
		expect(document.body.textContent).toContain("Updating Device Software"),
	);
	// When the backend sends clear plus terminal in one frame, then the overlay retracts.
	transport.message?.("status", {
		updating: null,
		update_state: {
			kind: "update_preflight_failed",
			preflight_reason: "statfs_failed",
		},
	});
	flushSync();
	await waitFor(() =>
		expect(document.body.textContent).not.toContain("Updating Device Software"),
	);
	expect(
		document.querySelector('[data-testid="update-preflight-reason"]'),
	).not.toBeNull();
	transport.message?.("status", { is_streaming: false });
	flushSync();
	expect(document.body.textContent).not.toContain("Updating Device Software");
});
