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
 *
 * Every case drives the REAL `subscriptions.svelte.ts` ingestion — only the RPC
 * transport (`$lib/rpc/client`) is doubled. A mocked `getStatus()` would prove
 * the render and nothing about the store beneath it, and the reconnect case
 * below is precisely a claim about that store: an update survives a backend
 * restart because nothing on the socket-close path clears the `updating` slot,
 * and the post-login initial push replaces it rather than racing it.
 */
import type { StatusMessage } from "@ceraui/rpc/schemas";
import { render, waitFor } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
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

// The ONLY double: the RPC transport. `initSubscriptions()` registers the real
// `handleMessage` / `handleConnectionChange` here, so the tests below feed the
// genuine ingestion path rather than a stubbed getter.
const transport = vi.hoisted(() => ({
	message: undefined as
		| ((type: string, data: unknown, seq?: number) => void)
		| undefined,
	connection: undefined as ((state: string) => void) | undefined,
	// The reconnect safety hydrate deliberately says NOTHING about `updating`:
	// a hydrate that omits the field must not retract an update in progress.
	hydratedStatus: {} as Record<string, unknown>,
	hydrateCalls: 0,
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: { login: vi.fn(async () => ({ success: true })) },
		streaming: { getConfig: vi.fn(async () => ({})) },
		status: {
			getStatus: vi.fn(async () => {
				transport.hydrateCalls += 1;
				return transport.hydratedStatus;
			}),
		},
	},
	rpcClient: {
		onMessage: (fn: (type: string, data: unknown, seq?: number) => void) => {
			transport.message = fn;
		},
		onConnectionChange: (fn: (state: string) => void) => {
			transport.connection = fn;
			return () => undefined;
		},
		connect: () => undefined,
		isConnected: () => true,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
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
	markAuthenticated: vi.fn(),
	clearSessionExpired: vi.fn(),
	markSessionExpired: vi.fn(),
	shouldExpireSession: () => false,
	wasAuthenticated: () => true,
}));

vi.mock("$lib/stores/auth-status.svelte", () => ({
	authenticate: vi.fn(async () => ({ kind: "ok" })),
	authenticateWithToken: vi.fn(async () => ({ kind: "ok" })),
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

import {
	initSubscriptions,
	resetState,
} from "../lib/rpc/subscriptions.svelte.ts";

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

type UpdatingFrame = Exclude<StatusMessage["updating"], boolean | null>;

/** Push a `status` broadcast through the real ingestion path. */
function pushStatus(frame: Record<string, unknown>): void {
	transport.message?.("status", frame);
	flushSync();
}

function updating(frame: UpdatingFrame): void {
	pushStatus({ updating: frame });
}

/**
 * The overlay's own title node. Identity matters: if the mount predicate ever
 * dips false, Svelte destroys this node and builds a new one on the way back —
 * so a stable reference across a transition IS the "no flicker" proof, and it
 * does not depend on catching an intermediate paint.
 */
function overlayTitle(): Element | undefined {
	return Array.from(document.querySelectorAll("h1")).find((el) =>
		el.textContent?.includes("Updating Device Software"),
	);
}

beforeEach(() => {
	localStorage.setItem("auth", "token-abc");
	transport.hydratedStatus = {};
	transport.hydrateCalls = 0;
	resetState();
	initSubscriptions();
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

describe("Layout — the update overlay survives a backend restart", () => {
	it("is on screen from the FIRST paint when Layout re-mounts onto an update already in flight", () => {
		updating({ total: 4, downloading: 4, unpacking: 1, setting_up: 0 });
		render(Layout);

		// Deliberately no `waitFor`: the store already carries the frame, so the
		// overlay must be on screen the moment the mount settles, with no extra
		// async round. Do not "fix" a future failure here by adding `waitFor` —
		// that would let a mount predicate that needs a second settle pass, and a
		// second settle is exactly the flash of idle layout this locks out.
		expect(overlayTitle()).toBeDefined();
	});

	it("stays mounted across close → reconnect → initial push, with no flicker to the idle layout", async () => {
		updating({ total: 4, downloading: 4, unpacking: 1, setting_up: 0 });
		render(Layout);

		await waitFor(() => {
			expect(overlayTitle()).toBeDefined();
		});
		const mounted = overlayTitle();
		expect(mounted).toBeDefined();

		// 1. The socket drops. Nothing on this path clears the `updating` slot —
		//    `resetState()` is a test/logout seam and is NOT wired to a close — so
		//    the overlay must stay exactly where it is.
		transport.connection?.("disconnected");
		flushSync();
		await tick();
		expect(overlayTitle()).toBe(mounted);

		// 2. The socket comes back. The reconnect re-auth + safety hydrate run, and
		//    that hydrate says nothing about `updating`; an omitted field is
		//    preserved by the status merge, so it must not retract the overlay.
		transport.connection?.("connected");
		flushSync();
		await tick();
		expect(overlayTitle()).toBe(mounted);

		// Drain the async reauth/hydrate dispatches.
		await vi.waitFor(() => {
			expect(transport.hydrateCalls).toBeGreaterThan(0);
		});
		await tick();
		flushSync();
		expect(overlayTitle()).toBe(mounted);

		// 3. The backend's post-login initial push arrives and REPLACES the slot
		//    with the live frame (todo 15 locks that `buildInitialStatus()` carries
		//    `updating`/`update_state`). The overlay updates in place — the same
		//    node, never destroyed and rebuilt.
		pushStatus({
			is_streaming: false,
			wifi: {},
			modems: {},
			updating: { total: 4, downloading: 4, unpacking: 3, setting_up: 0 },
			update_state: { kind: "idle" },
		});
		await tick();

		expect(overlayTitle()).toBe(mounted);
		expect(document.body.textContent).toContain("Updating Device Software");
		// The progress moved, so the mount really is reading the post-reconnect
		// frame rather than a frozen pre-drop snapshot.
		expect(document.body.textContent).toContain("58%");
	});
});
