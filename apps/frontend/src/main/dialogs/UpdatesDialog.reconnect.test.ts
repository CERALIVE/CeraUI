// @vitest-environment jsdom
/**
 * A whole check hidden by an outage (round-2 review C, M2), through the REAL
 * subscription layer and its reconnect re-authentication.
 *
 * The dialog is open at `idle`; Check is delivered; the link drops before the
 * reply or any phase push, so the immediate details read fails too. While the
 * browser is away the device runs the check and returns to `idle`. Reconnect
 * hydrates `idle` again: the PHASE never changed, so only a details read made
 * after the session was restored can show that the check ran. The dialog must
 * make that read itself; "This updates as soon as the device reports its
 * state" is otherwise a promise nothing keeps.
 */
import type { UpdateDetails } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	initSubscriptions,
	resetState,
} from "../../lib/rpc/subscriptions.svelte";
import UpdatesDialog from "./UpdatesDialog.svelte";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

const device = vi.hoisted(() => {
	const state: {
		linkUp: boolean;
		checkedAt: number;
		message?: (type: string, data: unknown, seq?: number) => void;
		connection?: (state: ConnectionState) => void;
		failCheck?: (error: Error) => void;
	} = { linkUp: true, checkedAt: 1_000 };
	return state;
});

function details(checkedAt: number): UpdateDetails {
	const clock = {
		lastAttemptAt: checkedAt,
		lastSuccessAt: checkedAt,
		nextAttemptAt: 900_000,
	};
	return {
		slots: null,
		os: { bootedVersion: "2026.10.70", staged: null, candidate: null },
		checks: { packages: clock, os: clock },
		pendingCellular: null,
		transport: null,
	};
}

const IDLE = {
	schema: 1,
	phase: "idle",
	progress: null,
	failure_reason: null,
	cellular_override_id: null,
};

vi.mock("$lib/rpc/client", () => {
	const reachable = <T>(value: () => T) =>
		vi.fn(() =>
			device.linkUp
				? Promise.resolve(value())
				: Promise.reject(new Error("WebSocket not connected")),
		);
	class ConnectionResetError extends Error {
		override readonly name = "ConnectionResetError";
	}
	return {
		ConnectionResetError,
		rpc: {
			auth: { login: reachable(() => ({ success: true })) },
			streaming: { getConfig: reachable(() => ({})) },
			status: {
				getStatus: reachable(() => ({ update_orchestrator: IDLE })),
			},
			system: {
				checkForUpdates: reachable(() => ({ success: true })),
				getUpdateCapabilities: reachable(() => ({
					mode: "capable",
					features: ["apt-all-packages", "rauc-verity-streaming", "slot-sync"],
				})),
				getUpdateSettings: reachable(() => ({
					packagesAuto: true,
					systemAuto: true,
					schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
					channel: "stable",
					allowPackagesOverCellular: true,
					allowSystemOverCellular: false,
				})),
				getUpdateDetails: reachable(() => details(device.checkedAt)),
				checkUpdatesNow: vi.fn(
					() =>
						new Promise((_resolve, rejectCheck) => {
							device.failCheck = rejectCheck;
						}),
				),
			},
		},
		rpcClient: {
			onMessage: (fn: (type: string, data: unknown, seq?: number) => void) => {
				device.message = fn;
			},
			onConnectionChange: (fn: (state: ConnectionState) => void) => {
				device.connection = fn;
				return () => {};
			},
			connect: () => {},
			isConnected: () => device.linkUp,
			getSocket: () => undefined,
			sendLegacy: () => {},
		},
	};
});
vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
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

const { rpc, ConnectionResetError } = await import("$lib/rpc/client");

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

beforeEach(() => {
	device.linkUp = true;
	device.checkedAt = 1_000;
	localStorage.setItem("auth", "remembered-device-token");
	resetState();
	initSubscriptions();
	device.connection?.("connected");
	device.message?.("status", { update_orchestrator: IDLE });
});

afterEach(() => {
	cleanup();
	resetState();
	vi.clearAllMocks();
});

describe("UpdatesDialog — a check hidden by an outage (M2)", () => {
	it("re-reads the details once the session is restored, even though the phase never moved", async () => {
		// Given the dialog open at idle, its details read.
		render(UpdatesDialog, { open: true });
		await waitFor(() => {
			expect(screen.getByTestId("update-system-check")).not.toBeNull();
		});

		// When Check is delivered and the link drops before any reply.
		await fireEvent.click(screen.getByTestId("update-system-check"));
		await waitFor(() => {
			expect(rpc.system.checkUpdatesNow).toHaveBeenCalledTimes(1);
		});
		device.linkUp = false;
		device.failCheck?.(new ConnectionResetError(["system", "checkUpdatesNow"]));
		device.connection?.("disconnected");

		// Then the dialog cannot know what became of it.
		const band = await screen.findByTestId("update-action-unconfirmed");
		expect(band.getAttribute("data-action")).toBe("check");
		await screen.findByTestId("update-details-failed");
		const readsWhileAway = vi.mocked(rpc.system.getUpdateDetails).mock.calls
			.length;

		// When the device finishes that check while the browser is away, and the
		// link comes back with the device still idle.
		device.checkedAt = 2_000;
		device.linkUp = true;
		device.connection?.("connected");

		// Then the restored session reads the details again, and the device's
		// own clocks settle the question.
		await waitFor(() => {
			expect(screen.queryByTestId("update-action-unconfirmed")).toBeNull();
		});
		expect(
			vi.mocked(rpc.system.getUpdateDetails).mock.calls.length,
		).toBeGreaterThan(readsWhileAway);
		expect(screen.queryByTestId("update-details-failed")).toBeNull();
		expect(screen.queryByTestId("update-action-refused")).toBeNull();
		expect(rpc.status.getStatus).toHaveBeenCalled();
	});
});
