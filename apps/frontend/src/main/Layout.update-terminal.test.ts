// @vitest-environment jsdom
/**
 * A terminal package-install outcome RELEASES the update takeover, in the app
 * (early oracle F1/F3, 2026-10-13).
 *
 * The device publishes the terminal `updating` object (a failure string or the
 * success result 0), then clears its own latch and publishes only
 * `update_state`. The store keeps an omitted field on purpose (an update in
 * flight outlives its socket), so the terminal object is the last word the page
 * gets about `updating`. These tests drive the REAL subscription store and the
 * REAL Layout mount predicate, UpdateBanner and overlay, with the frames the
 * backend sends (`software-updates.ts`: refresh failure, transaction failure,
 * success), and assert in the operator's terms: the failure stays visible, the
 * non-dismissible takeover is gone without a reload, ordinary controls are
 * reachable again, and every terminal outcome is announced exactly once.
 */
import { render } from "@testing-library/svelte";
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
vi.mock("./layout/LayoutToastHost.svelte", noop);
vi.mock("./MainView.svelte", async () => ({
	default: (await import("../tests/fixtures/MainControlsStub.svelte")).default,
}));
vi.mock("$lib/components/custom/pwa", async () => {
	const Noop = (await import("../tests/fixtures/Noop.svelte")).default;
	return { OfflinePage: Noop, PWAStatus: Noop };
});

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

const transport = vi.hoisted(() => ({
	message: undefined as
		| ((type: string, data: unknown, seq?: number) => void)
		| undefined,
	connection: undefined as ((state: string) => void) | undefined,
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: { login: vi.fn(async () => ({ success: true })) },
		streaming: { getConfig: vi.fn(async () => ({})) },
		status: { getStatus: vi.fn(async () => ({})) },
		ui: { heartbeat: vi.fn(async () => undefined) },
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
	revokePersistentToken: vi.fn(async () => undefined),
	authStatusStore: {
		value: true,
		set: vi.fn(),
		subscribe: (cb: (v: boolean) => void) => {
			cb(true);
			return () => {};
		},
	},
}));

import { initSubscriptions, resetState } from "../lib/rpc/subscriptions.svelte";

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

function push(frame: Record<string, unknown>): void {
	transport.message?.("status", frame);
	flushSync();
}

/**
 * Let the page settle on the fake clock. bits-ui hands the body back (its
 * `pointer-events: none` lock) 24 ms after the last modal layer is destroyed,
 * so "reachable" is only decidable once that teardown had its turn.
 */
async function settle(): Promise<void> {
	await tick();
	await vi.advanceTimersByTimeAsync(100);
	flushSync();
}

// The frames, literally as `software-updates.ts` builds them.
const STARTED = { downloading: 0, unpacking: 0, setting_up: 0, total: 0 };
const IDENTITY = { version: "abc123def456", packages: ["cerastream"] };
const REFRESH_REASON = "apt-get update failed: Temporary failure resolving";
const APT_REASON = "E: Sub-process /usr/bin/dpkg returned an error code (1)";

function takeover(): Element | null {
	return document.querySelector('[data-testid="updating-overlay"]');
}

/** True while something Layout mounted keeps the operator from the page. */
function controlsBlocked(): boolean {
	if (takeover() !== null) return true;
	if (document.body.style.pointerEvents === "none") return true;
	const retry = document.querySelector('[data-testid="main-retry"]');
	if (retry === null) return true;
	return retry.closest('[inert], [aria-hidden="true"]') !== null;
}

function bannerSaysInProgress(): boolean {
	return (document.body.textContent ?? "").includes("Update in progress");
}

async function startInstall(): Promise<void> {
	render(Layout);
	push({
		updating: STARTED,
		update_state: { kind: "downloading", progress: STARTED },
	});
	await settle();
	// Precondition: the running install IS a takeover, with its banner.
	expect(takeover()).not.toBeNull();
	expect(controlsBlocked()).toBe(true);
	expect(bannerSaysInProgress()).toBe(true);
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.setItem("auth", "token-abc");
	resetState();
	initSubscriptions();
	toastSuccess.mockReset();
	toastError.mockReset();
});

afterEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
	document.body.removeAttribute("style");
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("a terminal update outcome releases the takeover (through the real store and Layout)", () => {
	it("repository refresh failure: failure shown once, takeover gone, controls reachable", async () => {
		await startInstall();

		// When the refresh fails: the failure object, then update_state alone.
		push({
			updating: { ...STARTED, result: REFRESH_REASON },
			update_state: { kind: "failed", reason: REFRESH_REASON },
		});
		push({ update_state: { kind: "failed", reason: REFRESH_REASON } });
		await settle();

		// Then the operator has the page back, and sees the device's reason once.
		expect(takeover()).toBeNull();
		expect(controlsBlocked()).toBe(false);
		expect(bannerSaysInProgress()).toBe(false);
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenCalledWith("Update Failed", {
			description: REFRESH_REASON,
		});
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("APT transaction failure after progress: failure shown once, takeover gone", async () => {
		await startInstall();
		const progressed = {
			downloading: 2,
			unpacking: 2,
			setting_up: 1,
			total: 2,
		};
		push({
			updating: progressed,
			update_state: { kind: "installing", progress: progressed },
		});
		await settle();
		expect(takeover()).not.toBeNull();

		// When the detached transaction fails (settledStatus, then broadcastUpdateState()).
		push({
			updating: { ...progressed, result: APT_REASON },
			update_state: {
				kind: "failed",
				reason: APT_REASON,
				identity: IDENTITY,
			},
		});
		push({
			update_state: {
				kind: "failed",
				reason: APT_REASON,
				identity: IDENTITY,
			},
		});
		await settle();

		expect(takeover()).toBeNull();
		expect(controlsBlocked()).toBe(false);
		expect(bannerSaysInProgress()).toBe(false);
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenCalledWith("Update Failed", {
			description: APT_REASON,
		});
	});

	it("result zero: success is announced exactly once and claims no restart", async () => {
		await startInstall();
		const done = { downloading: 1, unpacking: 1, setting_up: 1, total: 1 };

		push({
			updating: { ...done, result: 0 },
			update_state: { kind: "success", identity: IDENTITY },
		});
		push({ update_state: { kind: "success", identity: IDENTITY } });
		await settle();

		expect(takeover()).toBeNull();
		expect(controlsBlocked()).toBe(false);
		expect(bannerSaysInProgress()).toBe(false);
		expect(toastSuccess).toHaveBeenCalledTimes(1);
		expect(toastSuccess).toHaveBeenCalledWith("Successfully Updated", {
			description:
				"The device installed the update. A service restart is not confirmed.",
		});
		expect(toastError).not.toHaveBeenCalled();
	});

	it("a re-mounted Layout and a repeated terminal frame do not announce again", async () => {
		await startInstall();
		push({
			updating: { ...STARTED, result: APT_REASON },
			update_state: { kind: "failed", reason: APT_REASON },
		});
		await settle();
		expect(takeover()).toBeNull();
		expect(toastError).toHaveBeenCalledTimes(1);

		// When the same terminal frame arrives again and Layout mounts anew.
		push({ updating: { ...STARTED, result: APT_REASON } });
		document.body.innerHTML = "";
		render(Layout);
		await settle();

		expect(toastError).toHaveBeenCalledTimes(1);
		expect(takeover()).toBeNull();
	});

	it("a new install after a failure takes over again, and its own outcome is announced", async () => {
		await startInstall();
		push({ updating: { ...STARTED, result: APT_REASON } });
		await settle();
		expect(takeover()).toBeNull();

		// When the operator retries and the device starts a new run.
		push({ updating: STARTED });
		await settle();
		expect(takeover()).not.toBeNull();
		push({ updating: { ...STARTED, result: APT_REASON } });
		await settle();

		// Then the second failure is its own announcement and the takeover ends.
		expect(toastError).toHaveBeenCalledTimes(2);
		expect(takeover()).toBeNull();
	});

	it("a running install keeps the takeover, whatever its counters say", async () => {
		await startInstall();
		const full = { downloading: 3, unpacking: 3, setting_up: 3, total: 3 };
		push({ updating: full });
		await settle();

		expect(takeover()).not.toBeNull();
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});
});
