// @vitest-environment jsdom
import type { LogBootInfo } from "@ceraui/rpc/schemas";
import {
	logAroundOutputSchema,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
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

import { BOOT_IDS, fourBoots } from "$lib/device-logs/__fixtures__/boots";
import { event, eventPage } from "$lib/device-logs/__fixtures__/events";
import { exportScopeRows } from "$lib/device-logs/__fixtures__/sharing";
import { formatBootTime } from "$lib/device-logs/boot-rows";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";
import { notifyHistoryChanged } from "$lib/device-logs/history-bus";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import LogsDialog from "./LogsDialog.svelte";

/**
 * A boot pick is the operator's latest action: a reply to anything started
 * before it (the view's own availability probe with its linked moment, an
 * Events "View raw logs" lookup) must not override it. The real dialog, the
 * real header and side pickers, and held replies released after the pick.
 */

const rpc = vi.hoisted(() => ({
	logs: {
		getStorage: vi.fn(),
		boots: vi.fn(),
		around: vi.fn(),
		query: vi.fn(),
		createExport: vi.fn(),
	},
	events: { list: vi.fn() },
}));
vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	setLogFollowListener: vi.fn(),
	setEventFeedListener: vi.fn(),
}));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({ isStreaming: false, isFullyStale: false }),
}));

function listed(bootId: string): LogBootInfo {
	const found = fourBoots().find((boot) => boot.bootId === bootId);
	if (found === undefined) throw new Error(`fourBoots() lists no ${bootId}`);
	return found;
}
const RUNNING = listed(BOOT_IDS.current);
const PREVIOUS = listed(BOOT_IDS.clean);
const AT = RUNNING.firstTs + 60_000;
const OPENING_LEVELS = ["error", "warning", "info"];
const sharing = en.systemLogs.sharing;
const raw = en.systemLogs.raw;
const boots = en.systemLogs.boots;
const started = (boot: LogBootInfo) =>
	boots.started.replace("{time}", formatBootTime(boot.firstTs, "en"));

function exactAround(bootId: string, at: number) {
	const page = {
		ok: true,
		entries: [],
		hasMore: false,
		termination: "end",
		continuation: null,
		historyEpoch: 0,
		bootId,
	};
	return logAroundOutputSchema.parse({
		ok: true,
		approximate: false,
		anchor: {
			cursor: "s=anchor",
			ts: at,
			bootId,
			level: "error",
			source: "app",
			unit: "ceraui.service",
			message: "linked moment",
			truncated: false,
			marker: null,
		},
		older: page,
		newer: page,
		olderQuery: { boot: bootId, direction: "older", limit: 50 },
		newerQuery: { boot: bootId, direction: "newer", limit: 50 },
	});
}

let media: MediaQueryControl | undefined;

function viewport(wide: boolean): void {
	media?.restore();
	media = installMediaQueries(
		(query) => query === "(min-width: 1024px)" && wide,
	);
}

function selectedTab(): string | undefined {
	return screen
		.getAllByRole("tab")
		.find((node) => node.getAttribute("aria-selected") === "true")
		?.textContent?.trim();
}

function option(picker: HTMLElement, boot: LogBootInfo | null): HTMLElement {
	const row =
		boot === null
			? within(picker).getByTestId("boot-option-all")
			: picker.querySelector<HTMLElement>(`[data-boot-id="${boot.bootId}"]`);
	if (row === null) throw new Error("the boot is not listed");
	return row;
}

/** The phone header's picker: open it, wait for the list, pick. */
async function pickInHeader(boot: LogBootInfo | null): Promise<void> {
	await fireEvent.click(await screen.findByTestId("boot-button"));
	const picker = await screen.findByTestId("boot-picker");
	await fireEvent.click(await waitFor(() => option(picker, boot)));
}

/** The side column's picker on a wide screen. */
async function pickInSide(boot: LogBootInfo | null): Promise<void> {
	const picker = await screen.findByTestId("boot-picker");
	await fireEvent.click(await waitFor(() => option(picker, boot)));
}

/** A newly opened confirmation from the toolbar: what it states, then the request it sends. */
async function exportFromToolbar(): Promise<{ rows: string[]; sent: unknown }> {
	await fireEvent.click(await screen.findByTestId("sharing-toolbar-export"));
	const dialog = await screen.findByRole("dialog", { name: sharing.export });
	const rows = exportScopeRows(dialog);
	await fireEvent.click(
		within(dialog).getByRole("button", { name: sharing.exportDownload }),
	);
	await waitFor(() => expect(rpc.logs.createExport).toHaveBeenCalledTimes(1));
	return { rows, sent: rpc.logs.createExport.mock.calls[0]?.[0] };
}

const opening = (label: string) => [
	boots.heading,
	label,
	raw.levelLabel,
	raw.levelInfo,
	raw.sourceLabel,
	raw.sourceAll,
];

beforeAll(async () => {
	await Promise.all([
		import("../system-logs/EventsTab.svelte"),
		import("../system-logs/RawLogsTab.svelte"),
	]);
});

beforeEach(() => {
	vi.clearAllMocks();
	rpc.logs.getStorage.mockReset().mockResolvedValue({});
	rpc.logs.boots.mockReset().mockResolvedValue(fourBoots());
	rpc.logs.around
		.mockReset()
		.mockResolvedValue(exactAround(RUNNING.bootId, AT));
	rpc.logs.query
		.mockReset()
		.mockResolvedValue({ ok: false, error: "READ_FAILED" });
	rpc.logs.createExport
		.mockReset()
		.mockResolvedValue({ ok: false, error: "BUSY" });
	rpc.events.list.mockReset().mockResolvedValue(eventPage([]));
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	bootSelection.reset();
	media?.restore();
	media = undefined;
	vi.restoreAllMocks();
});

const PICKS = [
	{
		name: "a previous boot",
		boot: PREVIOUS,
		wire: PREVIOUS.bootId,
		label: () => started(PREVIOUS),
	},
	{ name: "All boots again", boot: null, wire: "all", label: () => boots.all },
] as const;

describe("LogsDialog: a boot pick outranks a reply to anything started before it", () => {
	it.each(PICKS)(
		"on a phone, picking $name in the header while the view still loads keeps a linked moment from replacing it",
		async ({ boot, wire, label }) => {
			viewport(false);
			const probe = Promise.withResolvers<unknown>();
			rpc.logs.getStorage.mockReturnValue(probe.promise);
			render(LogsDialog, {
				props: {
					open: true,
					context: { tab: "raw", at: AT, bootId: RUNNING.bootId },
				},
			});
			await waitFor(() => expect(rpc.logs.getStorage).toHaveBeenCalled());

			await pickInHeader(boot);
			probe.resolve({});

			await screen.findByTestId("raw-logs");
			await waitFor(() =>
				expect(rpc.logs.query).toHaveBeenLastCalledWith(
					logQueryInputSchema.parse({ levels: OPENING_LEVELS, boot: wire }),
				),
			);
			expect(screen.queryByTestId("raw-anchor")).toBeNull();
			const { rows, sent } = await exportFromToolbar();
			expect(rows).toEqual(opening(label()));
			expect(sent).toEqual({
				filter: { sources: [], levels: OPENING_LEVELS },
				boot: wire,
			});
		},
	);

	it.each([
		{
			name: "All boots",
			boot: null,
			wire: "all",
			label: () => boots.all,
			eventBoot: RUNNING,
		},
		{
			name: "a previous boot",
			boot: PREVIOUS,
			wire: PREVIOUS.bootId,
			label: () => started(PREVIOUS),
			eventBoot: PREVIOUS,
		},
	] as const)(
		"re-picking the highlighted $name on Events while View raw logs is out keeps its late reply from opening Raw, and a new link still opens it",
		async ({ boot, wire, label, eventBoot }) => {
			viewport(true);
			const at = eventBoot.firstTs + 60_000;
			rpc.events.list.mockResolvedValue(
				eventPage([
					event(1, "device_started", {}, { bootId: eventBoot.bootId, at }),
				]),
			);
			render(LogsDialog, { props: { open: true } });
			if (boot !== null) await pickInSide(boot);
			const lookup = Promise.withResolvers<ReturnType<typeof exactAround>>();
			rpc.logs.around.mockReturnValueOnce(lookup.promise);
			await fireEvent.click(
				await screen.findByRole("button", {
					name: en.systemLogs.events.viewRaw,
				}),
			);
			await waitFor(() => expect(rpc.logs.around).toHaveBeenCalledTimes(1));

			await pickInSide(boot);
			lookup.resolve(exactAround(eventBoot.bootId, at));
			await lookup.promise;

			// Settled once the row's link is no longer pending, with Events still the tab.
			await waitFor(() => {
				expect(selectedTab()).toBe(en.systemLogs.tabs.events);
				const link = screen.queryByRole("button", {
					name: en.systemLogs.events.viewRaw,
				});
				expect(link).not.toBeNull();
				expect(link?.getAttribute("aria-disabled")).toBeNull();
			});
			expect(screen.queryByTestId("raw-logs")).toBeNull();
			const { rows, sent } = await exportFromToolbar();
			expect(rows).toEqual(opening(label()));
			expect(sent).toEqual({
				filter: { sources: [], levels: OPENING_LEVELS },
				boot: wire,
			});
			await fireEvent.click(
				within(
					await screen.findByRole("dialog", { name: sharing.export }),
				).getByRole("button", { name: en.dialogs.cancel }),
			);

			// A link asked for after the pick is the latest action: it opens Raw on its moment.
			await fireEvent.click(
				screen.getByRole("button", { name: en.systemLogs.events.viewRaw }),
			);
			await screen.findByTestId("raw-anchor");
			expect(selectedTab()).toBe(en.systemLogs.tabs.raw);
		},
	);

	it("opens a plain Raw logs tab on All boots once All boots was picked in this view", async () => {
		viewport(true);
		render(LogsDialog, { props: { open: true } });
		await pickInSide(null);

		await fireEvent.click(
			await screen.findByRole("tab", { name: en.systemLogs.tabs.raw }),
		);

		await screen.findByTestId("raw-logs");
		await waitFor(() =>
			expect(rpc.logs.query).toHaveBeenLastCalledWith(
				logQueryInputSchema.parse({ levels: OPENING_LEVELS, boot: "all" }),
			),
		);
		const { rows, sent } = await exportFromToolbar();
		expect(rows).toEqual(opening(boots.all));
		expect(sent).toEqual({
			filter: { sources: [], levels: OPENING_LEVELS },
			boot: "all",
		});
	});

	it("clears a View raw logs a re-pick superseded at once: no pending row, no late note, and a fresh link works", async () => {
		viewport(true);
		const at = RUNNING.firstTs + 60_000;
		rpc.events.list.mockResolvedValue(
			eventPage([
				event(1, "device_started", {}, { bootId: RUNNING.bootId, at }),
			]),
		);
		render(LogsDialog, { props: { open: true } });
		const lookup = Promise.withResolvers<{ ok: false; error: "BUSY" }>();
		rpc.logs.around.mockReturnValueOnce(lookup.promise);
		const link = await screen.findByRole("button", {
			name: en.systemLogs.events.viewRaw,
		});
		await fireEvent.click(link);
		expect(link.getAttribute("aria-disabled")).toBe("true");

		await pickInSide(null);
		await waitFor(() => expect(link.getAttribute("aria-disabled")).toBeNull());
		lookup.resolve({ ok: false, error: "BUSY" });
		await lookup.promise;
		await tick();

		expect(screen.queryByTestId("event-raw-note")).toBeNull();
		await fireEvent.click(link);
		await screen.findByTestId("raw-anchor");
		expect(rpc.logs.around).toHaveBeenCalledTimes(2);
	});
});

describe("LogsDialog: a boot recheck still out when the view closed changes nothing in the next one", () => {
	const ALL_LEVELS = ["error", "warning", "info", "debug"];

	async function recheckOutAcrossClose(): Promise<{
		reopen: (props: Record<string, unknown>) => Promise<void>;
		release: () => Promise<void>;
	}> {
		viewport(true);
		const view = render(LogsDialog, { props: { open: true } });
		await pickInSide(PREVIOUS);
		const read = Promise.withResolvers<LogBootInfo[]>();
		rpc.logs.boots.mockImplementation(() => read.promise);
		const calls = rpc.logs.boots.mock.calls.length;
		notifyHistoryChanged();
		await waitFor(() =>
			expect(rpc.logs.boots.mock.calls.length).toBeGreaterThan(calls),
		);
		await view.rerender({ open: false });
		await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());
		rpc.logs.boots.mockReset().mockResolvedValue(fourBoots());
		return {
			reopen: async (props) => {
				await view.rerender({ open: true, ...props });
				await screen.findByRole("tablist");
			},
			// The device no longer lists the boot the closed view had chosen.
			release: async () => {
				read.resolve(
					fourBoots().filter((boot) => boot.bootId !== PREVIOUS.bootId),
				);
				await read.promise;
				await tick();
			},
		};
	}

	it("keeps a fresh linked moment on Raw, and Export saves that moment", async () => {
		const { reopen, release } = await recheckOutAcrossClose();
		await reopen({ context: { tab: "raw", at: AT, bootId: RUNNING.bootId } });
		await screen.findByTestId("raw-anchor");

		await release();

		expect(screen.getByTestId("raw-anchor")).toBeTruthy();
		const { rows, sent } = await exportFromToolbar();
		expect(rows).toEqual([
			boots.heading,
			raw.timeBoot,
			raw.levelLabel,
			raw.levelEverything,
			raw.sourceLabel,
			raw.sourceAll,
			raw.timeLabel,
			`${formatBootTime(AT - 300_000, "en")} to ${formatBootTime(AT + 300_000, "en")}`,
		]);
		expect(sent).toEqual({
			filter: { sources: [], levels: ALL_LEVELS },
			boot: RUNNING.bootId,
			since: AT - 300_000,
			until: AT + 300_000,
		});
	});

	it("keeps a newly opened plain Raw tab on This boot, and Export saves this boot", async () => {
		const { reopen, release } = await recheckOutAcrossClose();
		await reopen({ context: undefined });
		await fireEvent.click(
			await screen.findByRole("tab", { name: en.systemLogs.tabs.raw }),
		);
		await screen.findByTestId("raw-logs");
		const thisBoot = logQueryInputSchema.parse({
			levels: OPENING_LEVELS,
			boot: "current",
		});
		await waitFor(() =>
			expect(rpc.logs.query).toHaveBeenLastCalledWith(thisBoot),
		);

		await release();

		expect(rpc.logs.query).toHaveBeenLastCalledWith(thisBoot);
		const { rows, sent } = await exportFromToolbar();
		expect(rows).toEqual(opening(boots.current));
		expect(sent).toEqual({
			filter: { sources: [], levels: OPENING_LEVELS },
			boot: "current",
		});
	});
});
