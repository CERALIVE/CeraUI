// @vitest-environment jsdom
/**
 * "View logs" on a standing notice opens the moment the notice is about.
 *
 * The device replays every standing notice to each connection it opens, so the
 * time a notice reached this page is its moment only when it arrived live. An
 * update notice is placed by the timeline event it emitted instead, which
 * holds the device's own time and an exact entry. Driven through the real
 * socket ingestion, the notice band and System Logs.
 */
import type { Notification } from "@ceraui/rpc/schemas";
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

import { BOOT_IDS, boot } from "$lib/device-logs/__fixtures__/boots";
import {
	aroundPage,
	event,
	eventPage,
} from "$lib/device-logs/__fixtures__/events";

const handlers = vi.hoisted(
	() =>
		({}) as {
			message?: (type: string, data: unknown) => void;
			connection?: (state: string) => void;
		},
);
const logs = vi.hoisted(() => ({
	getStorage: vi.fn(),
	boots: vi.fn(),
	around: vi.fn(),
	query: vi.fn(),
	followStart: vi.fn(),
	followStop: vi.fn(),
}));
const events = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("$lib/rpc/client", () => ({
	rpc: { logs, events, notifications: { dismiss: () => Promise.resolve({}) } },
	rpcClient: {
		onMessage: (fn: (type: string, data: unknown) => void) => {
			handlers.message = fn;
		},
		onConnectionChange: (fn: (state: string) => void) => {
			handlers.connection = fn;
		},
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));
vi.mock("$lib/stores/navigation-lazy", () => ({
	navigateToDestination: () => undefined,
}));

import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import {
	clearRequestedDialog,
	getRequestedDialogContext,
} from "$lib/stores/dialog-request.svelte";
import { clearNotifications } from "$lib/stores/notifications.svelte";
import PersistentNotices from "$main/notifications/PersistentNotices.svelte";
import SystemLogsView from "$main/system-logs/SystemLogsView.svelte";
import { en } from "./helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "./helpers/media-query";

const REPLAY_AT = 1_800_000_000_000;
const LIVE_AT = REPLAY_AT + 120_000;
const PAGE = {
	ok: true,
	entries: [],
	hasMore: false,
	termination: "end",
	continuation: null,
	historyEpoch: 0,
	bootId: BOOT_IDS.current,
};

const REFUSED: Notification = {
	name: "update:refused:txn-1",
	type: "warning",
	msg: "Update refused",
	key: "notifications.updateRefused",
	params: { reason: "apt: E: Sub-process returned an error code" },
	is_dismissable: true,
	is_persistent: true,
	duration: 0,
	revision: 4,
};
const RECOVERY_FAILED: Notification = {
	name: "stream_recovery_failed",
	type: "error",
	msg: "The stream could not be restored.",
	key: "notifications.streamRecoveryFailed",
	params: { reason: "engine_restart" },
	is_dismissable: true,
	is_persistent: true,
	duration: 0,
	revision: 2,
};

let media: MediaQueryControl;

function at(ms: number, step: () => void): void {
	const clock = vi.spyOn(Date, "now").mockReturnValue(ms);
	step();
	clock.mockRestore();
}

function connectAndReplay(standing: Notification[]): void {
	handlers.connection?.("connected");
	handlers.message?.("notification", { show: standing });
}

async function viewLogs(): Promise<unknown> {
	render(PersistentNotices);
	await fireEvent.click(screen.getByTestId("view-logs-action"));
	const context = getRequestedDialogContext();
	cleanup();
	return context;
}

// RawLogsPanel loads the Raw tab as a lazy chunk; loading it here keeps its first,
// cold transform out of the bounded waits below.
beforeAll(async () => {
	await import("$main/system-logs/RawLogsTab.svelte");
});

beforeEach(() => {
	media = installMediaQueries((query) => query === "(min-width: 1024px)");
	for (const fn of [...Object.values(logs), events.list]) fn.mockReset();
	logs.getStorage.mockResolvedValue({});
	logs.boots.mockResolvedValue([boot(BOOT_IDS.current, "current")]);
	logs.around.mockResolvedValue(aroundPage());
	logs.query.mockResolvedValue(PAGE);
	resetState();
	clearNotifications();
	clearRequestedDialog();
	initSubscriptions();
	handlers.connection?.("disconnected");
});

afterEach(() => {
	cleanup();
	media.restore();
	vi.restoreAllMocks();
});

describe("View logs on a standing notice opens its own moment", () => {
	it("opens a replayed update notice at the exact entry of its event after a reconnect", async () => {
		at(REPLAY_AT, () => connectAndReplay([REFUSED]));
		handlers.connection?.("disconnected");
		at(REPLAY_AT + 600_000, () => connectAndReplay([REFUSED]));
		const refusal = event(7, "update_refused", {
			id: "txn-1",
			reason: "dpkg lock held",
		});
		events.list.mockResolvedValue(
			eventPage([
				event(9, "update_installed", { id: "txn-1", packages: ["cerastream"] }),
				refusal,
			]),
		);

		const context = await viewLogs();
		expect(context).toEqual({
			tab: "raw",
			event: { family: "update", code: "update_refused", id: "txn-1" },
		});

		render(SystemLogsView, { props: { context } });
		await waitFor(() =>
			expect(logs.around).toHaveBeenCalledExactlyOnceWith({
				bootId: refusal.bootId,
				at: refusal.at,
				eventId: refusal.id,
			}),
		);
	});

	it.each([
		["a replayed notice that emits no event", RECOVERY_FAILED, []],
		[
			"a replayed update notice whose event is gone",
			REFUSED,
			[event(3, "update_refused", { id: "txn-0", reason: "x" })],
		],
	])(
		"opens Raw logs at the newest entries for %s",
		async (_case, notice, stored) => {
			events.list.mockResolvedValue(eventPage(stored));
			at(REPLAY_AT, () => connectAndReplay([notice]));

			const context = await viewLogs();
			expect(context).not.toHaveProperty("at");

			render(SystemLogsView, { props: { context } });
			await screen.findByTestId("raw-logs");
			await waitFor(() => expect(logs.query).toHaveBeenCalledTimes(1));
			expect(logs.around).not.toHaveBeenCalled();
			expect(screen.queryByTestId("raw-anchor")).toBeNull();
		},
	);

	it.each([
		["a replayed notice that emits no event", RECOVERY_FAILED, []],
		[
			"a replayed update notice whose event is gone",
			REFUSED,
			[event(3, "update_refused", { id: "txn-0", reason: "x" })],
		],
	])(
		"says above the newest entries that the moment of %s isn't known",
		async (_case, notice, stored) => {
			events.list.mockResolvedValue(eventPage(stored));
			at(REPLAY_AT, () => connectAndReplay([notice]));

			render(SystemLogsView, { props: { context: await viewLogs() } });

			const line = await screen.findByTestId("raw-moment-unknown");
			expect(line.textContent?.trim()).toBe(en.systemLogs.anchor.unknown);
			expect(line.className).toContain("text-muted-foreground");
			expect(
				line.compareDocumentPosition(screen.getByTestId("raw-scroller")) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		},
	);

	it("says nothing about the moment of a notice that arrived live", async () => {
		at(REPLAY_AT, () => connectAndReplay([]));
		at(LIVE_AT, () =>
			handlers.message?.("notification", { show: [RECOVERY_FAILED] }),
		);

		render(SystemLogsView, { props: { context: await viewLogs() } });

		await waitFor(() => expect(logs.around).toHaveBeenCalledTimes(1));
		await screen.findByTestId("raw-logs");
		expect(screen.queryByTestId("raw-moment-unknown")).toBeNull();
	});

	it("keeps the arrival of a notice that came live, after the replay", async () => {
		at(REPLAY_AT, () => connectAndReplay([]));
		at(LIVE_AT, () =>
			handlers.message?.("notification", { show: [RECOVERY_FAILED] }),
		);
		handlers.connection?.("disconnected");
		at(LIVE_AT + 90_000, () => connectAndReplay([RECOVERY_FAILED]));

		expect(await viewLogs()).toEqual({ tab: "raw", at: LIVE_AT });
	});
});
