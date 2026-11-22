// @vitest-environment jsdom
import {
	logAroundOutputSchema,
	logBootInfoSchema,
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
import { exportScopeRows } from "$lib/device-logs/__fixtures__/sharing";
import { formatBootTime } from "$lib/device-logs/boot-rows";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";
import { SharingFlow } from "$lib/device-logs/sharing-flow.svelte";
import { RpcError } from "$lib/rpc/rpc-error";
import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";
import SystemLogsView from "./SystemLogsView.svelte";

const logs = vi.hoisted(() => ({
	getStorage: vi.fn(),
	boots: vi.fn(),
	around: vi.fn(),
	query: vi.fn(),
	followStart: vi.fn(),
	followStop: vi.fn(),
	createExport: vi.fn(),
	previewBundle: vi.fn(),
	createBundle: vi.fn(),
}));
vi.mock("$lib/rpc/client", () => ({ rpc: { logs } }));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	setLogFollowListener: vi.fn(),
}));

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
const AT = 1_800_000_000_000;
const PAGE = {
	ok: true,
	entries: [],
	hasMore: false,
	termination: "end",
	continuation: null,
	historyEpoch: 0,
	bootId: BOOT,
};
const running = logBootInfoSchema.parse({
	bootId: BOOT,
	index: 0,
	current: true,
	shutdown: "current",
	firstTs: AT - 1_000_000,
	lastTs: AT,
	evidence: [],
	logsAvailable: true,
	versions: null,
});
const around = logAroundOutputSchema.parse({
	ok: true,
	approximate: true,
	anchor: null,
	older: PAGE,
	newer: PAGE,
	olderQuery: { boot: BOOT, since: AT - 60_000, until: AT },
	newerQuery: {
		boot: BOOT,
		direction: "newer",
		since: AT + 1,
		until: AT + 60_000,
	},
});
const ENTRY_AT = AT - 2_000;
const exactAround = logAroundOutputSchema.parse({
	ok: true,
	approximate: false,
	anchor: {
		cursor: "s=anchor",
		ts: ENTRY_AT,
		bootId: BOOT,
		level: "error",
		source: "app",
		unit: "ceraui.service",
		message: "update refused",
		truncated: false,
		marker: null,
	},
	older: PAGE,
	newer: PAGE,
	olderQuery: { boot: BOOT, direction: "older", limit: 50 },
	newerQuery: { boot: BOOT, direction: "newer", limit: 50 },
});
let media: MediaQueryControl;

// RawLogsPanel loads the Raw tab as a lazy chunk; loading it here keeps its first,
// cold transform out of the first test's bounded wait when the whole suite runs.
beforeAll(async () => {
	await import("./RawLogsTab.svelte");
});

beforeEach(() => {
	media = installMediaQueries((query) => query === "(min-width: 1024px)");
	for (const fn of Object.values(logs)) fn.mockReset();
	logs.getStorage.mockResolvedValue({});
	logs.boots.mockResolvedValue([running]);
	logs.around.mockResolvedValue(around);
	logs.query.mockResolvedValue(PAGE);
	logs.createExport.mockResolvedValue({ ok: false, error: "BUSY" });
});
afterEach(() => {
	cleanup();
	bootSelection.reset();
	media.restore();
	vi.restoreAllMocks();
});

async function exportView() {
	await fireEvent.click(await screen.findByTestId("sharing-open-export"));
	const body = await screen.findByRole("dialog", {
		name: en.systemLogs.sharing.export,
	});
	await fireEvent.click(
		within(body).getByRole("button", {
			name: en.systemLogs.sharing.exportDownload,
		}),
	);
	await waitFor(() => expect(logs.createExport).toHaveBeenCalledTimes(1));
	return logs.createExport.mock.calls[0]?.[0];
}

/** Opens Export from the Downloads row, reads its scope, asks for a ticket (BUSY) and cancels. */
async function exportScope(): Promise<string[]> {
	await fireEvent.click(await screen.findByTestId("sharing-open-export"));
	const body = await screen.findByRole("dialog", {
		name: en.systemLogs.sharing.export,
	});
	const scope = exportScopeRows(body);
	await fireEvent.click(
		within(body).getByRole("button", {
			name: en.systemLogs.sharing.exportDownload,
		}),
	);
	await within(body).findByTestId("sharing-export-problem");
	await fireEvent.click(
		within(body).getByRole("button", { name: en.dialogs.cancel }),
	);
	return scope;
}

async function rawWithErrors(text?: string): Promise<void> {
	await fireEvent.click(
		await screen.findByRole("tab", { name: en.systemLogs.tabs.raw }),
	);
	await screen.findByTestId("raw-logs");
	await fireEvent.click(
		screen.getByRole("radio", { name: en.systemLogs.raw.levelErrors }),
	);
	if (text !== undefined) {
		await fireEvent.input(screen.getByTestId("raw-search"), {
			target: { value: text },
		});
		await fireEvent.keyDown(screen.getByTestId("raw-search"), { key: "Enter" });
	}
	await waitFor(() =>
		expect(logs.query).toHaveBeenLastCalledWith(
			logQueryInputSchema.parse({ levels: ["error"], text }),
		),
	);
}

const raw = en.systemLogs.raw;
const boots = en.systemLogs.boots;

describe("System Logs deep-link integration", () => {
	it("resolves the running boot and opens the real Raw tab around the message, not the latest query", async () => {
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });

		await screen.findByTestId("raw-anchor-approximate");
		expect(logs.around).toHaveBeenCalledExactlyOnceWith({
			bootId: BOOT,
			at: AT,
		});
		expect(logs.query).not.toHaveBeenCalled();
		expect(screen.getByTestId("raw-anchor-empty")).toBeTruthy();
	});

	it("keeps the selected Raw tab focused when an approximate jump has no matching row", async () => {
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });
		await screen.findByTestId("raw-anchor-approximate");
		await tick();

		expect(document.activeElement).toBe(
			screen.getByRole("tab", { name: en.systemLogs.tabs.raw }),
		);
	});

	it("exports the combined around window, including the same boot and levels", async () => {
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });
		await screen.findByTestId("raw-anchor-approximate");

		expect(await exportView()).toEqual({
			filter: {
				sources: [],
				levels: ["error", "warning", "info", "debug"],
				text: undefined,
			},
			boot: BOOT,
			since: AT - 60_000,
			until: AT + 60_000,
		});
	});

	it("exports the ten minutes around an exact anchor with its levels, not its whole boot, and says so", async () => {
		logs.around.mockResolvedValue(exactAround);
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });
		await screen.findByTestId("raw-anchor");

		await fireEvent.click(await screen.findByTestId("sharing-open-export"));
		const body = await screen.findByRole("dialog", {
			name: en.systemLogs.sharing.export,
		});
		await fireEvent.click(
			within(body).getByRole("button", {
				name: en.systemLogs.sharing.exportDownload,
			}),
		);
		await waitFor(() => expect(logs.createExport).toHaveBeenCalledTimes(1));

		expect(logs.createExport.mock.calls[0]?.[0]).toEqual({
			filter: {
				sources: [],
				levels: ["error", "warning", "info", "debug"],
				text: undefined,
			},
			boot: BOOT,
			since: ENTRY_AT - 300_000,
			until: ENTRY_AT + 300_000,
		});
		expect(
			within(body).getByText(en.systemLogs.sharing.exportHintMoment),
		).toBeTruthy();
		expect(
			within(body).queryByText(en.systemLogs.sharing.exportHint),
		).toBeNull();
	});

	it("describes the Raw logs filters again once the view leaves the anchor", async () => {
		logs.around.mockResolvedValue(exactAround);
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });
		await fireEvent.click(await screen.findByTestId("raw-anchor-leave"));
		await waitFor(() => expect(logs.query).toHaveBeenCalledTimes(1));

		await fireEvent.click(await screen.findByTestId("sharing-open-export"));
		const body = await screen.findByRole("dialog", {
			name: en.systemLogs.sharing.export,
		});
		expect(
			within(body).getByText(en.systemLogs.sharing.exportHint),
		).toBeTruthy();
	});

	it("exports changed levels and search rather than the opening query after the Raw tab unmounts", async () => {
		const bindings = vi.spyOn(SharingFlow.prototype, "bindView");
		render(SystemLogsView);
		await fireEvent.click(
			await screen.findByRole("tab", { name: en.systemLogs.tabs.raw }),
		);
		await screen.findByTestId("raw-logs");
		await fireEvent.click(
			screen.getByRole("radio", { name: en.systemLogs.raw.levelErrors }),
		);
		await fireEvent.input(screen.getByTestId("raw-search"), {
			target: { value: "needle" },
		});
		await fireEvent.keyDown(screen.getByTestId("raw-search"), { key: "Enter" });
		await waitFor(() =>
			expect(logs.query).toHaveBeenLastCalledWith(
				logQueryInputSchema.parse({
					levels: ["error"],
					text: "needle",
				}),
			),
		);
		await fireEvent.click(
			screen.getByRole("tab", { name: en.systemLogs.tabs.events }),
		);
		bindings.mock.results[0]?.value?.publish({
			sources: ["kernel"],
			levels: ["debug"],
			boot: "all",
			since: 1,
			until: 2,
		});

		expect(await exportView()).toEqual({
			filter: { sources: [], levels: ["error"], text: "needle" },
			boot: "current",
			since: undefined,
			until: undefined,
		});
	});

	it("states Raw's kept filters on Events after Raw closes, then saves them across all boots once All boots is picked", async () => {
		render(SystemLogsView);
		await rawWithErrors("needle");
		await fireEvent.click(
			screen.getByRole("tab", { name: en.systemLogs.tabs.events }),
		);
		const kept = [
			raw.levelLabel,
			raw.levelErrors,
			raw.sourceLabel,
			raw.sourceAll,
			raw.searchLabel,
			"needle",
		];

		expect(await exportScope()).toEqual([
			boots.heading,
			boots.current,
			...kept,
		]);
		expect(logs.createExport).toHaveBeenLastCalledWith({
			filter: { sources: [], levels: ["error"], text: "needle" },
			boot: "current",
		});

		// All boots is already highlighted; picking it again is still the operator's choice.
		await fireEvent.click(screen.getByTestId("boot-option-all"));
		expect(await exportScope()).toEqual([boots.heading, boots.all, ...kept]);
		expect(logs.createExport).toHaveBeenLastCalledWith({
			filter: { sources: [], levels: ["error"], text: "needle" },
			boot: "all",
		});
	});

	it("states and saves what Raw logs shows when exported from Raw, following a boot picked there", async () => {
		render(SystemLogsView);
		await rawWithErrors();
		const levels = [
			raw.levelLabel,
			raw.levelErrors,
			raw.sourceLabel,
			raw.sourceAll,
		];

		expect(await exportScope()).toEqual([
			boots.heading,
			boots.current,
			...levels,
		]);
		expect(logs.createExport).toHaveBeenLastCalledWith({
			filter: { sources: [], levels: ["error"] },
			boot: "current",
		});

		await fireEvent.click(screen.getByTestId("boot-option-all"));
		await waitFor(() =>
			expect(logs.query).toHaveBeenLastCalledWith(
				logQueryInputSchema.parse({ levels: ["error"], boot: "all" }),
			),
		);
		expect(await exportScope()).toEqual([boots.heading, boots.all, ...levels]);
		expect(logs.createExport).toHaveBeenLastCalledWith({
			filter: { sources: [], levels: ["error"] },
			boot: "all",
		});
	});

	it("offers Retry and latest entries for a failed lookup, then retries the message", async () => {
		logs.around.mockResolvedValueOnce({ ok: false, error: "BUSY" });
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });
		const band = await screen.findByTestId("raw-anchor-failure");
		expect(band.getAttribute("role")).toBe("alert");
		expect(band.textContent).toContain(en.systemLogs.error.busy);

		await fireEvent.click(
			within(band).getByRole("button", { name: en.systemLogs.action.retry }),
		);
		await screen.findByTestId("raw-anchor-approximate");
		expect(logs.around).toHaveBeenCalledTimes(2);
	});

	it("shows loading instead of a stale error or the latest query while a retry is pending", async () => {
		logs.around.mockResolvedValueOnce({ ok: false, error: "READ_FAILED" });
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });
		const band = await screen.findByTestId("raw-anchor-failure");
		const reply = Promise.withResolvers<unknown>();
		logs.around.mockReturnValueOnce(reply.promise);
		await fireEvent.click(
			within(band).getByRole("button", { name: en.systemLogs.action.retry }),
		);

		expect(await screen.findByTestId("raw-logs-chunk-loading")).toBeTruthy();
		expect(screen.queryByTestId("raw-anchor-failure")).toBeNull();
		expect(screen.queryByTestId("raw-logs")).toBeNull();
		reply.resolve(around);
		await screen.findByTestId("raw-anchor-approximate");
		expect(logs.query).not.toHaveBeenCalled();
	});

	it("offers latest entries for removed logs without pretending the request succeeded", async () => {
		logs.around.mockResolvedValueOnce({ ok: false, error: "BOOT_UNAVAILABLE" });
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });
		const band = await screen.findByTestId("raw-anchor-failure");
		expect(band.textContent).toContain(en.systemLogs.error.bootRemoved);
		await fireEvent.click(
			within(band).getByRole("button", { name: en.systemLogs.anchor.leave }),
		);

		await screen.findByTestId("raw-logs");
		expect(logs.query).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("raw-anchor")).toBeNull();
	});

	it("discards an older reply when a new context arrives, and latest entries stay plain after a tab switch", async () => {
		const old = Promise.withResolvers<unknown>();
		logs.around.mockReturnValueOnce(old.promise);
		const view = render(SystemLogsView, {
			props: { context: { tab: "raw", at: AT } },
		});
		await waitFor(() => expect(logs.around).toHaveBeenCalledTimes(1));
		await view.rerender({ context: { tab: "raw", at: AT + 1 } });
		await screen.findByTestId("raw-anchor-approximate");
		old.resolve({ ok: false, error: "READ_FAILED" });
		await old.promise;
		await tick();
		expect(screen.queryByTestId("raw-anchor-failure")).toBeNull();

		await fireEvent.click(
			screen.getByRole("tab", { name: en.systemLogs.tabs.events }),
		);
		await fireEvent.click(
			screen.getByRole("tab", { name: en.systemLogs.tabs.raw }),
		);
		await screen.findByTestId("raw-logs");
		expect(logs.query).toHaveBeenCalledTimes(1);
		expect(logs.around).toHaveBeenCalledTimes(2);
		expect(screen.queryByTestId("raw-anchor")).toBeNull();
	});
});

// A second, earlier boot, so every choice below names a different boot on the wire.
const PREVIOUS = "5e0f6b1c2d3a49e88f7a6b5c4d3e2f10";
const previous = logBootInfoSchema.parse({
	bootId: PREVIOUS,
	index: 1,
	current: false,
	shutdown: "clean",
	firstTs: AT - 9_000_000,
	lastTs: AT - 5_000_000,
	evidence: [],
	logsAvailable: true,
	versions: null,
});
const OPENING_LEVELS = ["error", "warning", "info"];
const started = (boot: { firstTs: number }) =>
	boots.started.replace("{time}", formatBootTime(boot.firstTs, "en"));

function phone(): void {
	media.restore();
	media = installMediaQueries(() => false);
}

/** The side picker's row when it is on the page; otherwise what the phone header picker calls. */
async function pick(boot: typeof previous | null): Promise<void> {
	const picker = screen.queryByTestId("boot-picker");
	if (picker === null) {
		bootSelection.choose(boot);
		return;
	}
	const option = await waitFor(() => {
		const row =
			boot === null
				? within(picker).getByTestId("boot-option-all")
				: picker.querySelector<HTMLElement>(`[data-boot-id="${boot.bootId}"]`);
		if (row === null) throw new Error("the boot is not listed yet");
		return row;
	});
	await fireEvent.click(option);
}

async function showTab(name: string): Promise<void> {
	await fireEvent.click(await screen.findByRole("tab", { name }));
}

type Entry = "events" | "raw" | "storage" | "band";

/** Opens the Export confirmation the way the entry does. */
async function openExport(entry: Entry): Promise<HTMLElement> {
	if (entry === "band") {
		const band = await screen.findByTestId("system-logs-check-failed");
		await fireEvent.click(
			await within(band).findByTestId("system-logs-check-bundle"),
		);
		const bundle = await screen.findByRole("dialog", {
			name: en.systemLogs.sharing.bundle,
		});
		await fireEvent.click(
			await within(bundle).findByRole("button", {
				name: en.systemLogs.sharing.export,
			}),
		);
	} else if (entry === "storage") {
		await showTab(en.systemLogs.tabs.storage);
		await fireEvent.click(await screen.findByTestId("sharing-open-export"));
	} else {
		await fireEvent.click(await screen.findByTestId("sharing-toolbar-export"));
	}
	return screen.findByRole("dialog", { name: en.systemLogs.sharing.export });
}

async function download(dialog: HTMLElement): Promise<void> {
	await fireEvent.click(
		within(dialog).getByRole("button", {
			name: en.systemLogs.sharing.exportDownload,
		}),
	);
	await waitFor(() => expect(logs.createExport).toHaveBeenCalledTimes(1));
}

const SELECTIONS = [
	{ name: "All boots", boot: null, wire: "all", label: () => boots.all },
	{
		name: "a previous boot",
		boot: previous,
		wire: PREVIOUS,
		label: () => started(previous),
	},
	{
		name: "this boot",
		boot: running,
		wire: "current",
		label: () => boots.current,
	},
] as const;
const MATRIX = [
	...(["events", "raw", "storage"] as const).flatMap((entry) =>
		SELECTIONS.flatMap((selection) =>
			[false, true].map((retained) => ({ entry, selection, retained })),
		),
	),
	...SELECTIONS.map((selection) => ({
		entry: "band" as const,
		selection,
		retained: false,
	})),
];

describe("System Logs Export: one scope, stated and sent, by the operator's latest action", () => {
	it.each(MATRIX)(
		"from $entry with $selection.name picked, Raw filter set first: $retained",
		async ({ entry, selection, retained }) => {
			if (entry === "storage" || entry === "band") phone();
			logs.boots.mockResolvedValue([running, previous]);
			if (entry === "band") {
				vi.spyOn(console, "error").mockImplementation(() => {});
				logs.getStorage.mockRejectedValue(
					new Error("Request timeout: logs.getStorage"),
				);
				logs.previewBundle.mockRejectedValue(
					new RpcError({ message: "READ_FAILED", code: "INTERNAL_ERROR" }),
				);
			}
			render(SystemLogsView);
			if (retained) await rawWithErrors("needle");
			if (entry === "raw" && !retained) await showTab(en.systemLogs.tabs.raw);
			if (entry !== "raw" && retained) await showTab(en.systemLogs.tabs.events);
			if (entry !== "band") await screen.findByTestId("sharing-toolbar-export");
			await pick(selection.boot);

			const dialog = await openExport(entry);

			expect(exportScopeRows(dialog)).toEqual([
				boots.heading,
				selection.label(),
				raw.levelLabel,
				retained ? raw.levelErrors : raw.levelInfo,
				raw.sourceLabel,
				raw.sourceAll,
				...(retained ? [raw.searchLabel, "needle"] : []),
			]);
			if (retained)
				expect(within(dialog).getByText("needle").tagName).toBe("BDI");
			await download(dialog);
			expect(logs.createExport).toHaveBeenLastCalledWith({
				filter: {
					sources: [],
					levels: retained ? ["error"] : OPENING_LEVELS,
					text: retained ? "needle" : undefined,
				},
				boot: selection.wire,
			});
		},
	);

	it("states a bounded window by both ends, each time isolated, for a deep link's approximate Raw view", async () => {
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });
		await screen.findByTestId("raw-anchor-approximate");

		const dialog = await openExport("raw");

		const from = formatBootTime(AT - 60_000, "en");
		const to = formatBootTime(AT + 60_000, "en");
		expect(exportScopeRows(dialog)).toEqual([
			boots.heading,
			raw.timeBoot,
			raw.levelLabel,
			raw.levelEverything,
			raw.sourceLabel,
			raw.sourceAll,
			raw.timeLabel,
			`${from} to ${to}`,
		]);
		const isolated = within(dialog)
			.getByTestId("sharing-export-scope")
			.querySelectorAll("bdi");
		expect([...isolated].map((node) => node.textContent)).toEqual([from, to]);
		await download(dialog);
		expect(logs.createExport).toHaveBeenLastCalledWith({
			filter: { sources: [], levels: around.olderQuery.levels },
			boot: BOOT,
			since: AT - 60_000,
			until: AT + 60_000,
		});
	});

	it("keeps the stated scope and the request on what was confirmed while a deep link's Raw view arrives late", async () => {
		const lookup = Promise.withResolvers<typeof around>();
		logs.around.mockReturnValue(lookup.promise);
		const ticket = Promise.withResolvers<{ ok: false; error: "BUSY" }>();
		logs.createExport.mockReturnValue(ticket.promise);
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });

		const dialog = await openExport("raw");
		const stated = exportScopeRows(dialog);
		expect(stated).toEqual([
			boots.heading,
			boots.all,
			raw.levelLabel,
			raw.levelInfo,
			raw.sourceLabel,
			raw.sourceAll,
		]);
		await download(dialog);
		lookup.resolve(around);
		await screen.findByTestId("raw-anchor-approximate");
		expect(exportScopeRows(dialog)).toEqual(stated);
		ticket.resolve({ ok: false, error: "BUSY" });
		await within(dialog).findByTestId("sharing-export-problem");

		expect(exportScopeRows(dialog)).toEqual(stated);
		expect(logs.createExport).toHaveBeenCalledExactlyOnceWith({
			filter: { sources: [], levels: OPENING_LEVELS },
			boot: "all",
		});
	});

	it("keeps the stated scope and the request on what was confirmed when Raw publishes another view while it is open", async () => {
		const bindings = vi.spyOn(SharingFlow.prototype, "bindView");
		render(SystemLogsView);
		await rawWithErrors();
		const dialog = await openExport("raw");
		const stated = exportScopeRows(dialog);
		expect(stated).toEqual([
			boots.heading,
			boots.current,
			raw.levelLabel,
			raw.levelErrors,
			raw.sourceLabel,
			raw.sourceAll,
		]);

		bindings.mock.results.at(-1)?.value?.publish({
			sources: ["kernel"],
			levels: ["debug"],
			boot: PREVIOUS,
		});
		await tick();
		expect(exportScopeRows(dialog)).toEqual(stated);
		await download(dialog);

		expect(logs.createExport).toHaveBeenCalledExactlyOnceWith({
			filter: { sources: [], levels: ["error"] },
			boot: "current",
		});
	});

	it.each([
		{
			name: "a previous boot",
			boot: previous,
			wire: PREVIOUS,
			label: () => started(previous),
		},
		{
			name: "All boots again",
			boot: null,
			wire: "all",
			label: () => boots.all,
		},
	])(
		"saves $name picked on Events after an exact Raw moment, not the moment",
		async ({ boot, wire, label }) => {
			logs.boots.mockResolvedValue([running, previous]);
			logs.around.mockResolvedValue(exactAround);
			render(SystemLogsView, {
				props: { context: { tab: "raw", at: ENTRY_AT } },
			});
			await screen.findByTestId("raw-logs");
			await showTab(en.systemLogs.tabs.events);
			await pick(boot);

			const dialog = await openExport("events");

			expect(exportScopeRows(dialog)).toEqual([
				boots.heading,
				label(),
				raw.levelLabel,
				raw.levelEverything,
				raw.sourceLabel,
				raw.sourceAll,
			]);
			await download(dialog);
			expect(logs.createExport).toHaveBeenLastCalledWith({
				filter: { sources: [], levels: exactAround.olderQuery.levels },
				boot: wire,
			});
		},
	);

	it("saves the boot picked on a phone when a Raw deep link could not load and the failure band hands off to Export", async () => {
		phone();
		vi.spyOn(console, "error").mockImplementation(() => {});
		logs.getStorage.mockRejectedValue(
			new Error("Request timeout: logs.getStorage"),
		);
		logs.previewBundle.mockRejectedValue(
			new RpcError({ message: "READ_FAILED", code: "INTERNAL_ERROR" }),
		);
		render(SystemLogsView, { props: { context: { tab: "raw", at: AT } } });
		await screen.findByTestId("system-logs-check-failed");
		bootSelection.choose(previous);

		const dialog = await openExport("band");

		expect(exportScopeRows(dialog)).toEqual([
			boots.heading,
			started(previous),
			raw.levelLabel,
			raw.levelInfo,
			raw.sourceLabel,
			raw.sourceAll,
		]);
		await download(dialog);
		expect(logs.createExport).toHaveBeenLastCalledWith({
			filter: { sources: [], levels: OPENING_LEVELS },
			boot: PREVIOUS,
		});
	});
});

/** Opens the confirmation, reads what it states and cancels without asking for a ticket. */
async function peekScope(entry: Entry): Promise<string[]> {
	const dialog = await openExport(entry);
	const rows = exportScopeRows(dialog);
	await fireEvent.click(
		within(dialog).getByRole("button", { name: en.dialogs.cancel }),
	);
	await waitFor(() =>
		expect(
			screen.queryByRole("dialog", { name: en.systemLogs.sharing.export }),
		).toBeNull(),
	);
	return rows;
}

const MOMENT = [
	raw.timeLabel,
	`${formatBootTime(ENTRY_AT - 300_000, "en")} to ${formatBootTime(ENTRY_AT + 300_000, "en")}`,
];

describe("System Logs Export: a boot pick is the operator's latest action, also against a linked moment", () => {
	it.each([
		{
			name: "a previous boot",
			boot: previous,
			wire: PREVIOUS,
			label: () => started(previous),
		},
		{
			name: "All boots again",
			boot: null,
			wire: "all",
			label: () => boots.all,
		},
	])(
		"picking $name while a linked moment still loads opens Raw on the pick, and a new Export saves it",
		async ({ boot, wire, label }) => {
			logs.boots.mockResolvedValue([running, previous]);
			const lookup = Promise.withResolvers<typeof exactAround>();
			logs.around.mockReturnValue(lookup.promise);
			render(SystemLogsView, {
				props: { context: { tab: "raw", at: ENTRY_AT } },
			});
			await waitFor(() => expect(logs.around).toHaveBeenCalledTimes(1));

			await pick(boot);
			lookup.resolve(exactAround);
			await screen.findByTestId("raw-logs");
			await waitFor(() =>
				expect(logs.query).toHaveBeenLastCalledWith(
					logQueryInputSchema.parse({ levels: OPENING_LEVELS, boot: wire }),
				),
			);
			expect(screen.queryByTestId("raw-anchor")).toBeNull();
			await showTab(en.systemLogs.tabs.events);

			const dialog = await openExport("events");
			expect(exportScopeRows(dialog)).toEqual([
				boots.heading,
				label(),
				raw.levelLabel,
				raw.levelInfo,
				raw.sourceLabel,
				raw.sourceAll,
			]);
			await download(dialog);
			expect(logs.createExport).toHaveBeenLastCalledWith({
				filter: { sources: [], levels: OPENING_LEVELS },
				boot: wire,
			});
		},
	);

	it.each([
		{ ordering: "chosen on Events before the link opened", chosenFirst: true },
		{ ordering: "with nothing chosen before", chosenFirst: false },
	])(
		"re-picking the boot a linked moment is in ($ordering) shows that whole boot in Raw, and Export saves it",
		async ({ chosenFirst }) => {
			logs.boots.mockResolvedValue([running, previous]);
			logs.around.mockResolvedValue(exactAround);
			if (chosenFirst) bootSelection.choose(running);
			render(SystemLogsView, {
				props: { context: { tab: "raw", at: ENTRY_AT } },
			});
			await screen.findByTestId("raw-anchor");
			expect((await peekScope("raw")).slice(-2)).toEqual(MOMENT);

			await pick(running);

			await waitFor(() =>
				expect(screen.queryByTestId("raw-anchor")).toBeNull(),
			);
			expect(logs.query).toHaveBeenLastCalledWith(
				logQueryInputSchema.parse({ levels: OPENING_LEVELS, boot: "current" }),
			);
			const dialog = await openExport("raw");
			expect(exportScopeRows(dialog)).toEqual([
				boots.heading,
				boots.current,
				raw.levelLabel,
				raw.levelInfo,
				raw.sourceLabel,
				raw.sourceAll,
			]);
			await download(dialog);
			expect(logs.createExport).toHaveBeenLastCalledWith({
				filter: { sources: [], levels: OPENING_LEVELS },
				boot: "current",
			});
		},
	);
});
