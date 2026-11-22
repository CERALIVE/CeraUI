// @vitest-environment jsdom
import type { LogBootInfo, LogExportOutput } from "@ceraui/rpc/schemas";
import { logAroundOutputSchema } from "@ceraui/rpc/schemas";
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
import { eventPage } from "$lib/device-logs/__fixtures__/events";
import {
	BUNDLE_TICKET,
	bundleManifest,
	EXPORT_TICKET,
	exportScopeRows,
} from "$lib/device-logs/__fixtures__/sharing";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";
import { deliverLegacyLog } from "$lib/device-logs/download-gate.svelte";
import { getDeviceLog, getSystemLog } from "$lib/helpers/SystemHelper";
import { CallTimeoutError } from "$lib/rpc/rpc-timeouts";
import { nextSocketEpoch } from "$lib/rpc/socket-epoch.svelte";
import type { LogsDialogContext } from "$lib/stores/dialog-request.svelte";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import LogsDialogHost from "./__fixtures__/LogsDialogHost.svelte";

/**
 * Closing System Logs ends its open view in the same call that sets `open`
 * false: a ticket answered just before the close, whose continuation runs
 * after the close but before Svelte's update flush tears the view down, starts
 * no download, and a reopen on another entry exports its own view. The real
 * dialog, its own close control and the real browser hand-off.
 */

const rpc = vi.hoisted(() => {
	const tickets = {
		sent: [] as string[],
		reply: Promise.withResolvers<LogExportOutput>(),
		replies: [] as PromiseWithResolvers<LogExportOutput>[],
	};
	const hold = (kind: string) => {
		tickets.sent.push(kind);
		tickets.reply = Promise.withResolvers<LogExportOutput>();
		tickets.replies.push(tickets.reply);
		return tickets.reply.promise;
	};
	return {
		tickets,
		logs: {
			getStorage: vi.fn(),
			boots: vi.fn(),
			around: vi.fn(),
			query: vi.fn(),
			previewBundle: vi.fn(),
			// Plain functions, not mocks: a mock's own bookkeeping adds a promise step
			// between the device's reply and the flow, which moves the window under test.
			createExport: () => hold("export"),
			createBundle: () => hold("bundle"),
		},
		events: { list: vi.fn() },
	};
});
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

const sharing = en.systemLogs.sharing;
const raw = en.systemLogs.raw;
const boots = en.systemLogs.boots;
function running(): LogBootInfo {
	const found = fourBoots().find((boot) => boot.bootId === BOOT_IDS.current);
	if (found === undefined) throw new Error("fourBoots() lists no running boot");
	return found;
}
const RUNNING = running();
const AT = RUNNING.firstTs + 60_000;
const ALL_BOOTS_SCOPE = [
	boots.heading,
	boots.all,
	raw.levelLabel,
	raw.levelInfo,
	raw.sourceLabel,
	raw.sourceAll,
];

let media: MediaQueryControl | undefined;
let anchorClicks: ReturnType<typeof vi.spyOn>;
let hrefs: string[];

function linkedMoment() {
	const page = {
		ok: true,
		entries: [],
		hasMore: false,
		termination: "end",
		continuation: null,
		historyEpoch: 0,
		bootId: RUNNING.bootId,
	};
	return logAroundOutputSchema.parse({
		ok: true,
		approximate: false,
		anchor: {
			cursor: "s=anchor",
			ts: AT,
			bootId: RUNNING.bootId,
			level: "error",
			source: "app",
			unit: "ceraui.service",
			message: "linked moment",
			truncated: false,
			marker: null,
		},
		older: page,
		newer: page,
		olderQuery: { boot: RUNNING.bootId, direction: "older", limit: 50 },
		newerQuery: { boot: RUNNING.bootId, direction: "newer", limit: 50 },
	});
}

/**
 * The parent's close written `hops` microtasks after the device answers the
 * held ticket, the way SettingsView writes `open`. Whether the reply's own
 * continuation (which starts the download) runs before or after the close and
 * the update flush it schedules depends on the hop, so every hop up to
 * `MAX_HOPS` is tried. The dialog's own close control is not the path here: it
 * first dismisses the nested sharing dialog, which already discards the ticket.
 */
async function closeAfter(
	start: () => Promise<void>,
	reply: LogExportOutput,
	hops: number,
	entry?: LogsDialogContext,
): Promise<{ late: boolean; host: { show(next?: LogsDialogContext): void } }> {
	rpc.tickets.sent = [];
	rpc.tickets.reply = Promise.withResolvers<LogExportOutput>();
	const host = render(LogsDialogHost).component;
	host.show(entry);
	await start();
	let closed = false;
	let late = false;
	anchorClicks.mockImplementation(() => {
		if (closed) late = true;
	});
	rpc.tickets.reply.resolve(reply);
	let hop = Promise.resolve();
	for (let i = 0; i < hops; i++) hop = hop.then(() => {});
	void hop.then(() => {
		closed = true;
		host.close();
	});
	// A task boundary: every continuation queued by the reply and the close has run.
	await new Promise((resolve) => setTimeout(resolve));
	return { late, host };
}

const MAX_HOPS = 12;
const HOPS = Array.from({ length: MAX_HOPS + 1 }, (_, hops) => hops);

async function exportStarted(): Promise<void> {
	await fireEvent.click(await screen.findByTestId("sharing-toolbar-export"));
	const dialog = await screen.findByRole("dialog", { name: sharing.export });
	await fireEvent.click(
		within(dialog).getByRole("button", { name: sharing.exportDownload }),
	);
	await waitFor(() => expect(rpc.tickets.sent).toEqual(["export"]));
}

async function bundleStarted(): Promise<void> {
	await fireEvent.click(await screen.findByTestId("sharing-toolbar-bundle"));
	const dialog = await screen.findByRole("dialog", { name: sharing.bundle });
	await within(dialog).findByRole("table");
	await fireEvent.click(
		within(dialog).getByRole("button", { name: sharing.bundleDownload }),
	);
	await waitFor(() => expect(rpc.tickets.sent).toEqual(["bundle"]));
}

beforeAll(async () => {
	await Promise.all([
		import("../system-logs/EventsTab.svelte"),
		import("../system-logs/RawLogsTab.svelte"),
	]);
});

beforeEach(() => {
	vi.clearAllMocks();
	nextSocketEpoch();
	rpc.tickets.sent = [];
	rpc.tickets.replies = [];
	rpc.tickets.reply = Promise.withResolvers<LogExportOutput>();
	media = installMediaQueries((query) => query === "(min-width: 1024px)");
	rpc.logs.getStorage.mockReset().mockResolvedValue({});
	rpc.logs.boots.mockReset().mockResolvedValue(fourBoots());
	rpc.logs.around.mockReset().mockResolvedValue(linkedMoment());
	rpc.logs.query
		.mockReset()
		.mockResolvedValue({ ok: false, error: "READ_FAILED" });
	rpc.logs.previewBundle.mockReset().mockResolvedValue(bundleManifest(3));
	rpc.events.list.mockReset().mockResolvedValue(eventPage([]));
	hrefs = [];
	anchorClicks = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(function (this: HTMLAnchorElement) {
			hrefs.push(this.href);
		});
	Object.assign(URL, {
		createObjectURL: vi.fn(() => "blob:log"),
		revokeObjectURL: vi.fn(),
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	bootSelection.reset();
	media?.restore();
	media = undefined;
	vi.restoreAllMocks();
});

const CASES = [
	{ name: "an export", start: exportStarted, ticket: EXPORT_TICKET },
	{ name: "a support bundle", start: bundleStarted, ticket: BUNDLE_TICKET },
] as const;

describe("LogsDialog: closing ends the open view before any queued reply runs", () => {
	it.each(CASES)(
		"the same successful $name ticket starts one download while open",
		async ({ start, ticket }) => {
			render(LogsDialogHost).component.show();
			await start();

			rpc.tickets.reply.resolve(ticket);

			await waitFor(() => expect(anchorClicks).toHaveBeenCalledTimes(1));
		},
	);

	it.each(CASES)(
		"$name ticket answered around the parent's close starts no download after it",
		async ({ start, ticket }) => {
			const late: number[] = [];
			for (const hops of HOPS) {
				if ((await closeAfter(start, ticket, hops)).late) late.push(hops);
				cleanup();
				bootSelection.reset();
			}
			expect(late).toEqual([]);
		},
	);

	it("a reopen on Events after such a close exports its own view", async () => {
		const wrong: number[] = [];
		for (const hops of HOPS) {
			const linked = async () => {
				await screen.findByTestId("raw-logs");
				await exportStarted();
			};
			const { late, host } = await closeAfter(linked, EXPORT_TICKET, hops, {
				tab: "raw",
				at: AT,
				bootId: RUNNING.bootId,
			});
			host.show({ tab: "events" });
			await fireEvent.click(
				await screen.findByTestId("sharing-toolbar-export"),
			);
			const reopened = await screen.findByRole("dialog", {
				name: sharing.export,
			});
			if (
				late ||
				exportScopeRows(reopened).join("|") !== ALL_BOOTS_SCOPE.join("|")
			)
				wrong.push(hops);
			cleanup();
			bootSelection.reset();
		}
		expect(wrong).toEqual([]);
	});

	it.each([
		{ name: "export", start: exportStarted, reply: EXPORT_TICKET },
		{ name: "bundle", start: bundleStarted, reply: BUNDLE_TICKET },
	] as const)(
		"a close and a reopen on Events in one turn give the new view a working $name download",
		async ({ name, start, reply }) => {
			const host = render(LogsDialogHost).component;
			host.show({ tab: "raw", at: AT, bootId: RUNNING.bootId });
			await screen.findByTestId("raw-logs");

			host.close();
			host.show({ tab: "events" });
			// The reopen's update flush, which mounts the new view: no one presses between two writes in one turn.
			await tick();

			if (name === "export") {
				await fireEvent.click(
					await screen.findByTestId("sharing-toolbar-export"),
				);
				const dialog = await screen.findByRole("dialog", {
					name: sharing.export,
				});
				expect(exportScopeRows(dialog)).toEqual(ALL_BOOTS_SCOPE);
				await fireEvent.click(
					within(dialog).getByRole("button", { name: sharing.exportDownload }),
				);
				await waitFor(() => expect(rpc.tickets.sent).toEqual(["export"]));
			} else await start();
			rpc.tickets.reply.resolve(reply);

			await waitFor(() => expect(anchorClicks).toHaveBeenCalledTimes(1));
		},
	);

	it("a close and a reopen in one turn give the new view the bundle refusal it is answered with", async () => {
		const host = render(LogsDialogHost).component;
		host.show({ tab: "raw", at: AT, bootId: RUNNING.bootId });
		await screen.findByTestId("raw-logs");

		host.close();
		host.show({ tab: "events" });
		// The reopen's update flush, which mounts the new view: no one presses between two writes in one turn.
		await tick();
		await bundleStarted();
		rpc.tickets.reply.resolve({ ok: false, error: "BUSY" });

		expect(await screen.findByTestId("sharing-bundle-problem")).toBeTruthy();
		expect(anchorClicks).not.toHaveBeenCalled();
	});
});

describe("LogsDialog: a reply for the closed view after a same-turn reopen", () => {
	it.each([
		{ name: "export", start: exportStarted, ticket: EXPORT_TICKET },
		{ name: "bundle", start: bundleStarted, ticket: BUNDLE_TICKET },
	] as const)(
		"the closed view's $name ticket starts nothing, and the new view's own one downloads",
		async ({ start, ticket }) => {
			const older = {
				...ticket,
				url: ticket.url.replace(/[0-9a-f]{64}$/, "a".repeat(64)),
			};
			const host = render(LogsDialogHost).component;
			host.show();
			await start();
			host.close();
			host.show({ tab: "events" });
			// The reopen's update flush, which mounts the new view: no one presses between two writes in one turn.
			await tick();
			rpc.tickets.sent = [];
			await start();

			rpc.tickets.replies[0]?.resolve(older);
			rpc.tickets.replies[1]?.resolve(ticket);

			await waitFor(() => expect(anchorClicks).toHaveBeenCalledTimes(1));
			expect(hrefs.map((href) => new URL(href).search)).toEqual([
				new URL(ticket.url, "http://device").search,
			]);
		},
	);
});

describe("LogsDialog: a legacy log file pushed after the close", () => {
	const FILE = { name: "ceralive_log.txt", contents: "first\n  second  \n" };

	it.each([
		{ name: "while open", close: false, downloads: 1 },
		{ name: "after the parent closed the dialog", close: true, downloads: 0 },
	] as const)(
		"the device's file pushed $name downloads $downloads time(s)",
		async ({ close, downloads }) => {
			const host = render(LogsDialogHost).component;
			host.show();
			const pushed = Promise.withResolvers<boolean>();
			vi.mocked(getDeviceLog).mockImplementation(() => {
				if (close) host.close();
				pushed.resolve(deliverLegacyLog(FILE));
				return Promise.resolve();
			});

			await fireEvent.click(await screen.findByTestId("log-download-device"));

			expect(await pushed.promise).toBe(downloads === 1);
			expect(anchorClicks).toHaveBeenCalledTimes(downloads);
		},
	);

	it.each([
		{ kind: "device", ask: getDeviceLog },
		{ kind: "system", ask: getSystemLog },
	] as const)(
		"the reopened view waits, busy, while the closed view's $kind log is outstanding, then saves its own and not that one",
		async ({ kind, ask }) => {
			const asked: (string | undefined)[] = [];
			const replies: PromiseWithResolvers<void>[] = [];
			vi.mocked(ask).mockImplementation((request?: string) => {
				asked.push(request);
				const reply = Promise.withResolvers<void>();
				replies.push(reply);
				return reply.promise;
			});
			const host = render(LogsDialogHost).component;
			host.show();
			await fireEvent.click(await screen.findByTestId(`log-download-${kind}`));
			host.close();
			host.show();
			await tick();
			await fireEvent.click(await screen.findByTestId(`log-download-${kind}`));

			expect(asked).toHaveLength(1);
			expect(
				(screen.getByTestId(`log-download-${kind}`) as HTMLButtonElement)
					.disabled,
			).toBe(true);
			expect(
				deliverLegacyLog({
					...FILE,
					contents: "closed view",
					request: asked[0],
				}),
			).toBe(false);
			replies[0]?.resolve();
			await waitFor(() => expect(asked).toHaveLength(2));
			expect(
				deliverLegacyLog({
					...FILE,
					contents: "reopened view",
					request: asked[1],
				}),
			).toBe(true);
			replies[1]?.resolve();

			const saved = vi
				.mocked(URL.createObjectURL)
				.mock.calls.map(([blob]) => blob as Blob);
			expect(await Promise.all(saved.map((blob) => blob.text()))).toEqual([
				"reopened view",
			]);
		},
	);

	it.each([
		{ kind: "device", ask: getDeviceLog },
		{ kind: "system", ask: getSystemLog },
	] as const)(
		"the $kind log whose call timed out shows the failure, and its late file is not saved",
		async ({ kind, ask }) => {
			const asked: (string | undefined)[] = [];
			vi.mocked(ask).mockImplementation((request?: string) => {
				asked.push(request);
				return Promise.reject(new CallTimeoutError("Request timeout"));
			});
			render(LogsDialogHost).component.show();

			await fireEvent.click(await screen.findByTestId(`log-download-${kind}`));

			expect(await screen.findByTestId("log-download-error")).toBeTruthy();
			expect(
				deliverLegacyLog({ ...FILE, contents: "late", request: asked[0] }),
			).toBe(false);
			expect(anchorClicks).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ kind: "device", ask: getDeviceLog },
		{ kind: "system", ask: getSystemLog },
	] as const)(
		"after the $kind log's call timed out, both downloads stay locked with the reconnect hint until its late file arrives",
		async ({ kind, ask }) => {
			vi.mocked(ask).mockRejectedValue(new CallTimeoutError("Request timeout"));
			render(LogsDialogHost).component.show();
			await fireEvent.click(await screen.findByTestId(`log-download-${kind}`));
			await screen.findByTestId("log-download-error");
			const buttons = ["device", "system"].map(
				(id) => screen.getByTestId(`log-download-${id}`) as HTMLButtonElement,
			);
			const hint = screen.getByTestId("log-download-locked");

			expect(hint.getAttribute("role")).toBe("status");
			expect(hint.textContent?.trim()).toBe(en.advanced.downloadLocked);
			for (const button of buttons) {
				expect(button.disabled).toBe(true);
				expect(button.getAttribute("aria-describedby")).toBe(hint.id);
			}
			expect(deliverLegacyLog({ ...FILE, contents: "late" })).toBe(false);
			await waitFor(() =>
				expect(screen.queryByTestId("log-download-locked")).toBeNull(),
			);
			for (const button of buttons) expect(button.disabled).toBe(false);
			expect(anchorClicks).not.toHaveBeenCalled();
		},
	);
});
