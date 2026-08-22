// @vitest-environment jsdom
/**
 * The full-screen update overlay is mounted ONCE, globally, by Layout — driven
 * only by `status.updating`. It is deliberately NOT owned by whichever surface
 * started the update, so an operator who opened Settings → Software Updates and
 * one who tapped an update notification see the identical live progress.
 *
 * A live report read as "the overlay only appears from the notification path".
 * It did not: the mount is trigger-agnostic and always was — no update had
 * actually started, so no `status.updating` frame ever arrived (see
 * `software-updates-start-refusal.test.ts` in the backend for that root cause).
 * These tests lock the trigger-agnostic mount and the real percentage/phase
 * render, so a future refactor cannot quietly make the overlay path-specific.
 */
import type { StatusMessage } from "@ceraui/rpc/schemas";
import { render, waitFor } from "@testing-library/svelte";
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
vi.mock("$lib/components/custom/pwa", async () => {
	const Noop = (await import("../tests/fixtures/Noop.svelte")).default;
	return { OfflinePage: Noop, PWAStatus: Noop };
});

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const statusState = vi.hoisted(() => ({
	value: undefined as unknown,
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => statusState.value,
}));

vi.mock("$lib/stores/offline-state.svelte", () => ({
	getShouldShowOfflinePage: () => false,
}));

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	deriveConnectionSurfaceUx: () => ({
		showOfflineBanner: false,
		showAuthTimeout: false,
		showConnectionLostToast: false,
	}),
	getDisconnectedSince: () => null,
	getGraceNow: () => 0,
	getHasConnected: () => true,
	markAuthenticated: vi.fn(),
	clearSessionExpired: vi.fn(),
	markSessionExpired: vi.fn(),
	shouldExpireSession: () => false,
	wasAuthenticated: () => true,
}));

vi.mock("$lib/stores/auth-status.svelte", () => ({
	authenticate: vi.fn(async () => {}),
	getAuthMessage: () => ({ success: true }),
	authStatusStore: {
		value: true,
		set: vi.fn(),
		subscribe: (cb: (v: boolean) => void) => {
			cb(true);
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

function updating(
	frame: Exclude<StatusMessage["updating"], boolean | null>,
): void {
	statusState.value = { updating: frame };
}

beforeEach(() => {
	localStorage.setItem("auth", "token-abc");
	statusState.value = undefined;
});

afterEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("Layout — the update overlay is mounted globally, not per trigger", () => {
	it("mounts on any status.updating frame, whatever started the update", async () => {
		updating({ total: 4, downloading: 4, unpacking: 2, setting_up: 0 });
		render(Layout);

		await waitFor(() => {
			expect(document.body.textContent).toContain("Updating Device Software");
		});
	});

	it("renders the real percentage and phase, not a bare 'Applying…'", async () => {
		// 6 of 12 steps done → 50%, currently unpacking.
		updating({ total: 4, downloading: 4, unpacking: 2, setting_up: 0 });
		render(Layout);

		await waitFor(() => {
			expect(document.body.textContent).toContain("50%");
		});
		expect(document.body.textContent).toContain("Unpacking");
		expect(document.body.textContent).toContain("2");
	});

	it("stays unmounted while no update is running", async () => {
		render(Layout);

		await waitFor(() => {
			expect(document.body.textContent).not.toContain(
				"Updating Device Software",
			);
		});
	});
});
