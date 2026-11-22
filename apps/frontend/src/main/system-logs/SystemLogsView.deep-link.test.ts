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
import { SharingFlow } from "$lib/device-logs/sharing-flow.svelte";

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
