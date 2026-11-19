// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import type {
	LogBundleManifest,
	LogExportInput,
	LogExportOutput,
	LogQueryInput,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitForElementToBeRemoved,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	BUNDLE_TICKET,
	bundleManifest,
	EXPORT_TICKET,
	signalled,
} from "$lib/device-logs/__fixtures__/sharing";
import { notifyHistoryChanged } from "$lib/device-logs/history-bus";
import { exportInput, startBackendDownload } from "$lib/device-logs/sharing";
import { SharingFlow } from "$lib/device-logs/sharing-flow.svelte";
import { getBackendHttpUrl } from "$lib/env";
import { RpcError } from "$lib/rpc/rpc-error";

import { de, en, zh } from "../../tests/helpers/catalog";

import SharingSection from "./SharingSection.svelte";

const createExport =
	vi.fn<(input: LogExportInput) => Promise<LogExportOutput>>();
const previewBundle = vi.fn<() => Promise<LogBundleManifest>>();
const createBundle = vi.fn<() => Promise<LogExportOutput>>();
let flow: SharingFlow;
let downloads: string[];
let clicked: PromiseWithResolvers<string>;

beforeEach(() => {
	createExport.mockReset();
	previewBundle.mockReset();
	createBundle.mockReset();
	downloads = [];
	clicked = Promise.withResolvers<string>();
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		downloads.push(this.href);
		clicked.resolve(this.href);
	});
	flow = new SharingFlow({
		logs: { createExport, previewBundle, createBundle },
		download: startBackendDownload,
	});
	render(SharingSection, { props: { sharing: flow } });
});

afterEach(() => {
	cleanup();
	flow.dispose();
	setLocale("en");
	vi.restoreAllMocks();
});

function tokens(element: Element | null | undefined): string[] {
	return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

const sharing = en.systemLogs.sharing;

// Japanese breaks at phrases, Korean only at spaces, Chinese only between the words its
// copy marks with <wbr> and balances its lines so no ending sits alone, and nothing
// overflows (C5 at 320/375 px).
const CJK_WRAP = [
	"[word-break:auto-phrase]",
	"[&:lang(ko)]:break-keep",
	"[&:lang(zh)]:break-keep",
	"wrap-break-word",
	"text-pretty",
	"[&:lang(zh)]:text-balance",
];

// The flow handles a reply a few promise hops after it lands; a bounded drain lets
// a late reply arrive before asserting that it changed nothing. Never timed.
async function drain(): Promise<void> {
	for (let turn = 0; turn < 100; turn++) await Promise.resolve();
}
const open = (id: "export" | "bundle") =>
	fireEvent.click(screen.getByTestId(`sharing-open-${id}`));
const dialog = (title: string) => screen.findByRole("dialog", { name: title });
const button = (scope: HTMLElement, name: string) =>
	within(scope).getByRole("button", { name }) as HTMLButtonElement;

describe("SharingSection: the second Downloads group", () => {
	it("lists Export this view then Support bundle after a neutral rule, with the browser line under them", () => {
		const group = screen.getByTestId("sharing-group");
		expect(tokens(group)).toEqual([
			"flex",
			"flex-col",
			"gap-3",
			"border-t",
			"pt-3",
			...CJK_WRAP,
		]);
		expect(
			within(group)
				.getAllByTestId(/^sharing-row-/)
				.map((row) => row.dataset.testid),
		).toEqual(["sharing-row-export", "sharing-row-bundle"]);
		const note = within(group).getByText(sharing.browserSaves);
		expect(tokens(note)).toEqual(["text-muted-foreground", "text-xs"]);
		expect(group.lastElementChild).toBe(note);
		expect(within(group).queryAllByRole("heading")).toHaveLength(0);
	});

	it.each([
		["export", sharing.export, sharing.exportHint, "lucide-file-output"],
		["bundle", sharing.bundle, sharing.bundleHint, "lucide-life-buoy"],
	] as const)(
		"draws the %s row in the shipped rows' anatomy",
		(id, title, hint, glyph) => {
			const row = screen.getByTestId(`sharing-row-${id}`);
			expect(tokens(row)).toEqual([
				"flex",
				"flex-wrap",
				"items-center",
				"gap-3",
				"rounded-lg",
				"border",
				"p-3",
			]);
			const tile = row.firstElementChild;
			expect(tokens(tile)).toEqual([
				"bg-secondary",
				"text-foreground",
				"grid",
				"size-10",
				"shrink-0",
				"place-items-center",
				"rounded-lg",
			]);
			expect(tile?.getAttribute("aria-hidden")).toBe("true");
			expect(tokens(tile?.querySelector("svg"))).toEqual(
				expect.arrayContaining(["size-5", glyph]),
			);
			const heading = within(row).getByText(title, { selector: "p" });
			expect(tokens(heading)).toEqual(["text-sm", "font-semibold"]);
			expect(tokens(heading.parentElement)).toEqual([
				"min-w-0",
				"grow",
				"basis-40",
			]);
			expect(tokens(within(row).getByText(hint))).toEqual([
				"text-muted-foreground",
				"text-xs",
			]);
			const action = screen.getByTestId(`sharing-open-${id}`);
			expect(action.textContent?.trim()).toBe(title);
			expect(action.dataset.slot).toBe("button");
			// A long label (de, hi at 320 px) wraps inside the button instead of overflowing the row.
			expect(tokens(action)).toEqual(
				expect.arrayContaining([
					"ms-auto",
					"h-auto",
					"max-w-full",
					"py-1",
					"whitespace-normal",
					"border-border",
					"text-[0.8rem]",
				]),
			);
			expect(tokens(action)).not.toContain("whitespace-nowrap");
			expect(tokens(action)).not.toContain("h-7");
			// A min-height utility would outrank the touch layer's 44 px lift (TT-1).
			expect(
				tokens(action).filter((token) => token.startsWith("min-h-")),
			).toEqual([]);
		},
	);

	it("renders each row in the active locale", async () => {
		setLocale("de");
		await tick();
		expect(screen.getByTestId("sharing-open-export").textContent?.trim()).toBe(
			de.systemLogs.sharing.export,
		);
		expect(screen.getByTestId("sharing-open-bundle").textContent?.trim()).toBe(
			de.systemLogs.sharing.bundle,
		);
		expect(screen.getByText(de.systemLogs.sharing.browserSaves)).toBeTruthy();
	});

	it("lets Chinese copy wrap only between words in the group and both dialogs", async () => {
		const copy = zh.systemLogs.sharing;
		const wraps = (element: HTMLElement) =>
			element.querySelectorAll("wbr").length;
		setLocale("zh");
		await tick();
		for (const text of [copy.exportHint, copy.bundleHint, copy.browserSaves]) {
			expect(wraps(screen.getByText(text))).toBeGreaterThan(0);
		}

		createExport.mockResolvedValue({ ok: false, error: "BUSY" });
		await open("export");
		const exportBody = await dialog(copy.export);
		expect(
			wraps(within(exportBody).getByText(copy.exportHint)),
		).toBeGreaterThan(0);
		expect(
			wraps(within(exportBody).getByTestId("sharing-export-sensitive")),
		).toBeGreaterThan(0);
		await fireEvent.click(button(exportBody, copy.exportDownload));
		const busy = await within(exportBody).findByText(copy.busy);
		expect(wraps(busy)).toBeGreaterThan(0);
		await fireEvent.click(button(exportBody, zh.dialogs.cancel));
		await waitForElementToBeRemoved(exportBody);

		vi.spyOn(console, "error").mockImplementation(() => {});
		previewBundle
			.mockRejectedValueOnce(
				new RpcError({ message: "READ_FAILED", code: "INTERNAL_ERROR" }),
			)
			.mockResolvedValueOnce(bundleManifest(3));
		createBundle.mockResolvedValue({ ok: false, error: "READ_FAILED" });
		await open("bundle");
		const bundleBody = await dialog(copy.bundle);
		expect(
			wraps(within(bundleBody).getByTestId("sharing-bundle-sensitive")),
		).toBeGreaterThan(0);
		expect(
			wraps(await within(bundleBody).findByText(copy.bundleFailed)),
		).toBeGreaterThan(0);
		await fireEvent.click(
			within(bundleBody).getByRole("button", {
				name: zh.systemLogs.action.retry,
			}),
		);
		await within(bundleBody).findByRole("table");
		await fireEvent.click(button(bundleBody, copy.bundleDownload));
		expect(
			wraps(await within(bundleBody).findByText(copy.failed)),
		).toBeGreaterThan(0);
	});
});

describe("SharingSection: Export this view", () => {
	it("states what the file holds and that it may be sensitive before anything downloads", async () => {
		await open("export");

		const body = await dialog(sharing.export);
		expect(within(body).getByText(sharing.exportHint)).toBeTruthy();
		const notice = within(body).getByTestId("sharing-export-sensitive");
		expect(notice.textContent?.trim()).toBe(sharing.exportSensitive);
		expect(button(body, sharing.exportDownload).disabled).toBe(false);
		expect(createExport).not.toHaveBeenCalled();
		expect(downloads).toEqual([]);
	});

	it("sends the Raw tab's current filter and points the anchor at the ticket on the backend origin", async () => {
		const view: LogQueryInput = {
			sources: ["network", "cellular"],
			levels: ["error", "warning"],
			text: "wwan0",
			boot: "current",
			direction: "older",
			limit: 100,
		};
		flow.view = view;
		createExport.mockResolvedValue(EXPORT_TICKET);
		await open("export");
		const body = await dialog(sharing.export);

		await fireEvent.click(button(body, sharing.exportDownload));
		await signalled(clicked.promise, "the download");

		expect(createExport).toHaveBeenCalledExactlyOnceWith(exportInput(view));
		expect(downloads).toEqual([getBackendHttpUrl(EXPORT_TICKET.url)]);
		expect(downloads[0]).toMatch(
			/^https?:\/\/[^/]+\/api\/logs\/export\?ticket=[0-9a-f]{64}$/,
		);
		await waitForElementToBeRemoved(body);
	});

	it("shows the request in flight, and Cancel discards a late ticket", async () => {
		const reply = Promise.withResolvers<LogExportOutput>();
		createExport.mockReturnValue(reply.promise);
		await open("export");
		const body = await dialog(sharing.export);

		await fireEvent.click(button(body, sharing.exportDownload));
		expect(button(body, sharing.exportDownload).disabled).toBe(true);
		const status = within(body).getByTestId("sharing-export-status");
		expect(status.getAttribute("role")).toBe("status");
		expect(status.textContent?.trim()).toBe(en.advanced.downloading);
		await fireEvent.click(button(body, en.dialogs.cancel));
		await waitForElementToBeRemoved(body);
		reply.resolve(EXPORT_TICKET);
		await drain();

		expect(flow.exportStep).toBe("closed");
		expect(downloads).toEqual([]);
	});

	it.each([
		["BUSY", sharing.busy],
		["READ_FAILED", sharing.failed],
	] as const)(
		"states a %s refusal in an alert band and Download export asks again",
		async (code, text) => {
			createExport
				.mockResolvedValueOnce({ ok: false, error: code })
				.mockResolvedValueOnce(EXPORT_TICKET);
			await open("export");
			const body = await dialog(sharing.export);

			await fireEvent.click(button(body, sharing.exportDownload));
			const band = await within(body).findByTestId("sharing-export-problem");
			expect(band.getAttribute("role")).toBe("alert");
			expect(band.textContent?.trim()).toBe(text);
			expect(tokens(band)).toEqual(
				expect.arrayContaining([
					"border-status-warning/30",
					"bg-status-warning/10",
				]),
			);
			expect(
				within(body).getByTestId("sharing-export-status").textContent,
			).toBe("");
			expect(button(body, sharing.exportDownload).disabled).toBe(false);

			await fireEvent.click(button(body, sharing.exportDownload));
			await signalled(clicked.promise, "the download");
			expect(createExport).toHaveBeenCalledTimes(2);
		},
	);

	it("states a malformed ticket in the alert band and keeps the confirmation", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		createExport.mockResolvedValue(null as unknown as LogExportOutput);
		await open("export");
		const body = await dialog(sharing.export);

		await fireEvent.click(button(body, sharing.exportDownload));

		const band = await within(body).findByTestId("sharing-export-problem");
		expect(band.textContent?.trim()).toBe(sharing.failed);
		expect(button(body, sharing.exportDownload).disabled).toBe(false);
		expect(downloads).toEqual([]);
	});

	it("states a download the browser refuses in the alert band and leaves no anchor behind", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		createExport.mockResolvedValue(EXPORT_TICKET);
		await open("export");
		const body = await dialog(sharing.export);

		await fireEvent.click(button(body, sharing.exportDownload));

		const band = await within(body).findByTestId("sharing-export-problem");
		expect(band.textContent?.trim()).toBe(sharing.failed);
		expect(document.querySelectorAll("a[download]")).toHaveLength(0);
		expect(button(body, sharing.exportDownload).disabled).toBe(false);
	});

	it("refuses a ticket that points off the backend origin, with the failed band and no anchor", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		createExport.mockResolvedValue({
			ok: true,
			url: "@example.invalid/support?ticket=controlled",
			expiresAt: 60000,
		});
		const created = vi.spyOn(document, "createElement");
		await open("export");
		const body = await dialog(sharing.export);

		await fireEvent.click(button(body, sharing.exportDownload));

		const band = await within(body).findByTestId("sharing-export-problem");
		expect(band.textContent?.trim()).toBe(sharing.failed);
		expect(downloads).toEqual([]);
		expect(created.mock.calls.filter(([tag]) => tag === "a")).toEqual([]);
		expect(flow.exportStep).toBe("confirm");
	});

	it("closes on Escape and opens clean again", async () => {
		createExport.mockResolvedValue({ ok: false, error: "BUSY" });
		await open("export");
		const body = await dialog(sharing.export);
		await fireEvent.click(button(body, sharing.exportDownload));
		await within(body).findByTestId("sharing-export-problem");

		await fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
		});
		await waitForElementToBeRemoved(body);
		await open("export");

		const reopened = await dialog(sharing.export);
		expect(within(reopened).queryByTestId("sharing-export-problem")).toBeNull();
	});
});

describe("SharingSection: support bundle", () => {
	it("prepares the preview with the review statement already shown and Download unavailable", async () => {
		previewBundle.mockReturnValue(new Promise<never>(() => {}));
		await open("bundle");

		const body = await dialog(sharing.bundle);
		const status = within(body).getByTestId("sharing-bundle-status");
		expect(status.getAttribute("role")).toBe("status");
		expect(status.textContent?.trim()).toBe(sharing.bundlePreparing);
		expect(
			within(body)
				.getByTestId("sharing-bundle-loading")
				.getAttribute("aria-hidden"),
		).toBe("true");
		expect(
			within(body).getByTestId("sharing-bundle-sensitive").textContent?.trim(),
		).toBe(sharing.bundleSensitive);
		expect(within(body).queryByRole("table")).toBeNull();
		expect(button(body, sharing.bundleDownload).disabled).toBe(true);
		expect(previewBundle).toHaveBeenCalledTimes(1);
	});

	it("lists every section with its entries and removed values, the boots and the running versions before Download is enabled", async () => {
		previewBundle.mockResolvedValue(bundleManifest(1234));
		await open("bundle");
		const body = await dialog(sharing.bundle);

		const table = await within(body).findByRole("table");
		const headers = within(table)
			.getAllByRole("columnheader")
			.map((cell) => cell.textContent?.trim());
		expect(headers).toEqual([sharing.bundleEntries, sharing.bundleRedactions]);
		const rows = within(table)
			.getAllByRole("row")
			.slice(1)
			.map((row) =>
				[...row.querySelectorAll("th, td")].map((cell) =>
					cell.textContent?.trim(),
				),
			);
		expect(rows).toEqual([
			[sharing.bundleSectionVersions, "2", "0"],
			[sharing.bundleSectionSettings, "6", "1"],
			[sharing.bundleSectionEvents, "14", "0"],
			[sharing.bundleSectionJournal, (1234).toLocaleString("en"), "9"],
		]);
		expect(within(table).getAllByRole("rowheader")).toHaveLength(4);
		expect(
			within(body).getByTestId("sharing-bundle-boots").textContent?.trim(),
		).toBe(sharing.bundleBoots.replace("{count}", "2"));

		const running = within(body).getByTestId("sharing-bundle-running");
		expect(within(running).getByRole("heading").textContent?.trim()).toBe(
			sharing.bundleRunning,
		);
		const versions = en.systemLogs.versions;
		const pairs = [...running.querySelectorAll("dt")].map((term) => [
			term.textContent?.trim(),
			term.nextElementSibling?.textContent?.trim(),
		]);
		expect(pairs).toEqual([
			[versions.systemImage, "2026.11.0"],
			[versions.slot, "a"],
			[versions.board, "rk3588"],
			[versions.boardModel, versions.notReported],
			[versions.ceraui, "2026.11.2"],
			[versions.engine, "2026.11.1"],
			[versions.sender, versions.notReported],
			[versions.kernel, "6.1.84"],
			[versions.bun, "1.4.4"],
		]);
		const reported = running.querySelector("dd bdi");
		expect(reported?.getAttribute("dir")).toBe("ltr");
		expect(tokens(running.querySelector("dd"))).toEqual(
			expect.arrayContaining(["font-mono", "wrap-anywhere"]),
		);
		expect(
			[...running.querySelectorAll("dd")]
				.filter((cell) => cell.textContent?.trim() === versions.notReported)
				.map((cell) => cell.dataset.state),
		).toEqual(["unknown", "unknown"]);

		expect(within(body).getByTestId("sharing-bundle-status").textContent).toBe(
			"",
		);
		expect(
			within(body).getByTestId("sharing-bundle-sensitive").textContent?.trim(),
		).toBe(sharing.bundleSensitive);
		expect(button(body, sharing.bundleDownload).disabled).toBe(false);
	});

	it("formats counts in the active locale", async () => {
		setLocale("de");
		previewBundle.mockResolvedValue(bundleManifest(12345));
		await open("bundle");
		const body = await dialog(de.systemLogs.sharing.bundle);

		const table = await within(body).findByRole("table");
		const journal = within(table).getByText(
			de.systemLogs.sharing.bundleSectionJournal,
		);
		expect(journal.parentElement?.textContent).toContain(
			(12345).toLocaleString("de"),
		);
	});

	it("downloads the bundle through the anchor on the backend origin and closes", async () => {
		previewBundle.mockResolvedValue(bundleManifest(3));
		createBundle.mockResolvedValue(BUNDLE_TICKET);
		await open("bundle");
		const body = await dialog(sharing.bundle);
		await within(body).findByRole("table");

		await fireEvent.click(button(body, sharing.bundleDownload));
		await signalled(clicked.promise, "the download");

		expect(createBundle).toHaveBeenCalledTimes(1);
		expect(downloads[0]).toBe(getBackendHttpUrl(BUNDLE_TICKET.url));
		expect(downloads[0]).toMatch(
			/^https?:\/\/[^/]+\/api\/logs\/bundle\?ticket=[0-9a-f]{64}$/,
		);
		await waitForElementToBeRemoved(body);
	});

	it("shows creation in flight on Download bundle", async () => {
		previewBundle.mockResolvedValue(bundleManifest(3));
		createBundle.mockReturnValue(new Promise<never>(() => {}));
		await open("bundle");
		const body = await dialog(sharing.bundle);
		await within(body).findByRole("table");

		await fireEvent.click(button(body, sharing.bundleDownload));

		expect(button(body, sharing.bundleDownload).disabled).toBe(true);
		expect(
			within(body).getByTestId("sharing-bundle-status").textContent?.trim(),
		).toBe(en.advanced.downloading);
		expect(within(body).getByRole("table")).toBeTruthy();
	});

	it.each([
		[
			"the sanitized READ_FAILED an identifier collision produces",
			"READ_FAILED",
			sharing.bundleFailed,
		],
		["BUSY", "BUSY", sharing.busy],
	] as const)(
		"states a preview refused with %s and offers Retry",
		async (_name, message, text) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			previewBundle
				.mockRejectedValueOnce(
					new RpcError({ message, code: "INTERNAL_ERROR" }),
				)
				.mockResolvedValueOnce(bundleManifest(7));
			await open("bundle");
			const body = await dialog(sharing.bundle);

			const band = await within(body).findByTestId("sharing-bundle-problem");
			expect(band.getAttribute("role")).toBe("alert");
			expect(within(band).getByText(text)).toBeTruthy();
			expect(within(body).queryByRole("table")).toBeNull();
			expect(within(body).queryByTestId("sharing-bundle-loading")).toBeNull();
			expect(button(body, sharing.bundleDownload).disabled).toBe(true);

			await fireEvent.click(
				within(band).getByRole("button", { name: en.systemLogs.action.retry }),
			);

			expect(await within(body).findByRole("table")).toBeTruthy();
			expect(within(body).queryByTestId("sharing-bundle-problem")).toBeNull();
			expect(previewBundle).toHaveBeenCalledTimes(2);
		},
	);

	it.each([
		["BUSY", sharing.busy],
		["READ_FAILED", sharing.failed],
	] as const)(
		"keeps the preview when creation is refused with %s, without a Retry of its own",
		async (code, text) => {
			previewBundle.mockResolvedValue(bundleManifest(3));
			createBundle.mockResolvedValue({ ok: false, error: code });
			await open("bundle");
			const body = await dialog(sharing.bundle);
			await within(body).findByRole("table");

			await fireEvent.click(button(body, sharing.bundleDownload));

			const band = await within(body).findByTestId("sharing-bundle-problem");
			expect(within(band).getByText(text)).toBeTruthy();
			expect(within(band).queryByRole("button")).toBeNull();
			expect(within(body).getByRole("table")).toBeTruthy();
			expect(button(body, sharing.bundleDownload).disabled).toBe(false);
			expect(downloads).toEqual([]);
		},
	);

	it("states a preview missing its versions and boots as a failed preview with Retry, and Download stays unavailable", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		previewBundle
			.mockResolvedValueOnce({ sections: [] } as unknown as LogBundleManifest)
			.mockResolvedValueOnce(bundleManifest(5));
		await open("bundle");
		const body = await dialog(sharing.bundle);

		const band = await within(body).findByTestId("sharing-bundle-problem");
		expect(within(band).getByText(sharing.bundleFailed)).toBeTruthy();
		expect(within(body).queryByRole("table")).toBeNull();
		expect(button(body, sharing.bundleDownload).disabled).toBe(true);

		await fireEvent.click(
			within(band).getByRole("button", { name: en.systemLogs.action.retry }),
		);
		expect(await within(body).findByRole("table")).toBeTruthy();
	});

	it("refuses a manifest naming a section twice with the failed preview band, never rendering it", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		previewBundle.mockResolvedValueOnce({
			...bundleManifest(0),
			sections: [
				{ id: "versions", entries: 1, redactions: 0 },
				{ id: "versions", entries: 2, redactions: 0 },
			],
		});
		await open("bundle");
		const body = await dialog(sharing.bundle);

		const band = await within(body).findByTestId("sharing-bundle-problem");
		expect(within(band).getByText(sharing.bundleFailed)).toBeTruthy();
		expect(within(body).queryByRole("table")).toBeNull();
		expect(button(body, sharing.bundleDownload).disabled).toBe(true);
		expect(flow.manifest).toBeNull();
	});

	it("Cancel during creation discards a ticket that lands while the dialog closes, and clears the preview", async () => {
		const reply = Promise.withResolvers<LogExportOutput>();
		previewBundle.mockResolvedValue(bundleManifest(3));
		createBundle.mockReturnValue(reply.promise);
		await open("bundle");
		const body = await dialog(sharing.bundle);
		await within(body).findByRole("table");

		await fireEvent.click(button(body, sharing.bundleDownload));
		await fireEvent.click(button(body, en.dialogs.cancel));
		reply.resolve(BUNDLE_TICKET);
		await waitForElementToBeRemoved(body);
		await drain();

		expect(flow.bundleStep).toBe("closed");
		expect(flow.manifest).toBeNull();
		expect(downloads).toEqual([]);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("Cancel during the preview discards the late manifest, and reopening previews again", async () => {
		const first = Promise.withResolvers<LogBundleManifest>();
		previewBundle.mockReturnValueOnce(first.promise);
		await open("bundle");
		const body = await dialog(sharing.bundle);

		await fireEvent.click(button(body, en.dialogs.cancel));
		first.resolve(bundleManifest(99));
		await first.promise;
		await waitForElementToBeRemoved(body);
		expect(flow.manifest).toBeNull();

		previewBundle.mockReturnValueOnce(new Promise<never>(() => {}));
		await open("bundle");
		const reopened = await dialog(sharing.bundle);
		expect(within(reopened).getByTestId("sharing-bundle-loading")).toBeTruthy();
		expect(previewBundle).toHaveBeenCalledTimes(2);
	});

	it("reads the preview again after stored history is deleted", async () => {
		previewBundle
			.mockResolvedValueOnce(bundleManifest(500))
			.mockResolvedValueOnce(bundleManifest(4));
		await open("bundle");
		const body = await dialog(sharing.bundle);
		await within(body).findByText((500).toLocaleString("en"));

		notifyHistoryChanged();

		expect(await within(body).findByText("4")).toBeTruthy();
		expect(within(body).queryByText((500).toLocaleString("en"))).toBeNull();
		expect(previewBundle).toHaveBeenCalledTimes(2);
	});
});

describe("SharingSection: dialog anatomy", () => {
	it("draws the export confirmation as a hint, a calm sensitive-data note and a status line", async () => {
		await open("export");
		const body = await dialog(sharing.export);

		const content = within(body).getByText(sharing.exportHint).parentElement;
		expect(tokens(content)).toEqual(["flex", "flex-col", "gap-4", ...CJK_WRAP]);
		expect(tokens(within(body).getByText(sharing.exportHint))).toEqual([
			"text-sm",
		]);
		const note = within(body).getByTestId("sharing-export-sensitive");
		expect(tokens(note)).toEqual(["text-sm"]);
		expect(tokens(note.parentElement)).toEqual([
			"flex",
			"items-start",
			"gap-3",
			"rounded-lg",
			"border",
			"p-3",
		]);
		const glyph = note.parentElement?.querySelector("svg");
		expect(glyph?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(glyph)).toEqual(
			expect.arrayContaining([
				"text-muted-foreground",
				"mt-0.5",
				"size-4",
				"shrink-0",
			]),
		);
		expect(tokens(within(body).getByTestId("sharing-export-status"))).toEqual([
			"text-muted-foreground",
			"text-sm",
			"empty:hidden",
		]);
		expect(content?.lastElementChild).toBe(
			within(body).getByTestId("sharing-export-status"),
		);
	});

	it("draws an export refusal as the amber band with a decorative warning glyph", async () => {
		createExport.mockResolvedValue({ ok: false, error: "BUSY" });
		await open("export");
		const body = await dialog(sharing.export);
		await fireEvent.click(button(body, sharing.exportDownload));

		const band = await within(body).findByTestId("sharing-export-problem");
		expect(tokens(band)).toEqual([
			"border-status-warning/30",
			"bg-status-warning/10",
			"flex",
			"items-start",
			"gap-3",
			"rounded-lg",
			"border",
			"p-3",
		]);
		const glyph = band.querySelector(":scope > svg");
		expect(glyph?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(glyph)).toEqual(
			expect.arrayContaining([
				"text-status-warning",
				"mt-0.5",
				"size-4",
				"shrink-0",
			]),
		);
		expect(tokens(within(band).getByText(sharing.busy))).toEqual(["text-sm"]);
	});

	it("draws the preview skeleton as four hidden rows", async () => {
		previewBundle.mockReturnValue(new Promise<never>(() => {}));
		await open("bundle");
		const body = await dialog(sharing.bundle);

		const loading = within(body).getByTestId("sharing-bundle-loading");
		expect(tokens(loading)).toEqual(["flex", "flex-col", "gap-2"]);
		const bones = [...loading.querySelectorAll('[data-slot="skeleton"]')];
		expect(bones.map((bone) => tokens(bone).slice(-2))).toEqual([
			["h-6", "w-full"],
			["h-6", "w-full"],
			["h-6", "w-full"],
			["h-6", "w-full"],
		]);
		const status = within(body).getByTestId("sharing-bundle-status");
		expect(tokens(status)).toEqual([
			"text-muted-foreground",
			"text-sm",
			"empty:hidden",
		]);
		const note = within(body).getByTestId("sharing-bundle-sensitive");
		expect(status.parentElement?.firstElementChild).toBe(note.parentElement);
		expect(note.parentElement?.nextElementSibling).toBe(status);
		expect(tokens(status.parentElement)).toEqual([
			"flex",
			"flex-col",
			"gap-4",
			...CJK_WRAP,
		]);
	});

	it("draws the manifest as a quiet table, the boots line, the versions list and the sensitive-data note last", async () => {
		previewBundle.mockResolvedValue(bundleManifest(3));
		await open("bundle");
		const body = await dialog(sharing.bundle);
		const table = await within(body).findByRole("table");

		expect(tokens(table)).toEqual(["w-full", "text-sm"]);
		const head = table.querySelector("thead");
		expect(tokens(head)).toEqual(["text-muted-foreground", "text-xs"]);
		const headCells = [...(head?.querySelectorAll("tr > *") ?? [])];
		expect(headCells.map((cell) => cell.tagName)).toEqual(["TD", "TH", "TH"]);
		expect(headCells[0]?.textContent).toBe("");
		for (const cell of headCells.slice(1)) {
			expect(cell.getAttribute("scope")).toBe("col");
			expect(tokens(cell)).toEqual(["ps-3", "pb-1", "text-end", "font-normal"]);
		}
		expect(tokens(table.querySelector("tbody"))).toEqual(["divide-y"]);
		const first = table.querySelector("tbody tr");
		const rowHeader = first?.querySelector("th");
		expect(rowHeader?.getAttribute("scope")).toBe("row");
		expect(tokens(rowHeader)).toEqual(["py-1.5", "text-start", "font-normal"]);
		for (const cell of first?.querySelectorAll("td") ?? []) {
			expect(tokens(cell)).toEqual([
				"py-1.5",
				"ps-3",
				"text-end",
				"tabular-nums",
			]);
		}
		expect(tokens(within(body).getByTestId("sharing-bundle-boots"))).toEqual([
			"text-muted-foreground",
			"text-xs",
		]);

		const running = within(body).getByTestId("sharing-bundle-running");
		expect(running.tagName).toBe("SECTION");
		expect(tokens(running)).toEqual(["flex", "flex-col", "gap-2"]);
		const heading = within(running).getByRole("heading");
		expect(heading.tagName).toBe("H3");
		expect(tokens(heading)).toEqual(["text-sm", "font-semibold"]);
		const list = running.querySelector("dl");
		expect(tokens(list)).toEqual([
			"grid",
			"grid-cols-[auto_minmax(0,1fr)]",
			"gap-x-4",
			"gap-y-1",
			"text-xs",
		]);
		for (const term of running.querySelectorAll("dt")) {
			expect(tokens(term)).toEqual(["text-muted-foreground"]);
		}
		const unknown = [...running.querySelectorAll('dd[data-state="unknown"]')];
		expect(unknown.map((cell) => tokens(cell))).toEqual([[], []]);
		const reported = [...running.querySelectorAll("dd:not([data-state])")];
		expect(reported).toHaveLength(7);
		for (const cell of reported) {
			expect(tokens(cell)).toEqual(["font-mono", "wrap-anywhere"]);
			expect(cell.firstElementChild?.tagName).toBe("BDI");
			expect(cell.firstElementChild?.getAttribute("dir")).toBe("ltr");
		}

		const note = within(body).getByTestId("sharing-bundle-sensitive");
		expect(tokens(note)).toEqual(["text-sm"]);
		const box = note.parentElement;
		expect(tokens(box)).toEqual([
			"flex",
			"items-start",
			"gap-3",
			"rounded-lg",
			"border",
			"p-3",
		]);
		// First in the body, so a short screen shows it before Download is reached.
		expect(box?.parentElement?.firstElementChild).toBe(box);
		const glyph = box?.querySelector("svg");
		expect(glyph?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(glyph)).toEqual(
			expect.arrayContaining([
				"text-muted-foreground",
				"mt-0.5",
				"size-4",
				"shrink-0",
			]),
		);
	});

	it("draws a refused preview as the amber band with a small outline Retry", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		previewBundle.mockRejectedValue(
			new RpcError({ message: "READ_FAILED", code: "INTERNAL_ERROR" }),
		);
		await open("bundle");
		const body = await dialog(sharing.bundle);

		const band = await within(body).findByTestId("sharing-bundle-problem");
		expect(tokens(band)).toEqual([
			"border-status-warning/30",
			"bg-status-warning/10",
			"flex",
			"items-start",
			"gap-3",
			"rounded-lg",
			"border",
			"p-3",
		]);
		const glyph = band.querySelector(":scope > svg");
		expect(glyph?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(glyph)).toEqual(
			expect.arrayContaining([
				"text-status-warning",
				"mt-0.5",
				"size-4",
				"shrink-0",
			]),
		);
		const inner = band.querySelector(":scope > div");
		expect(tokens(inner)).toEqual([
			"flex",
			"min-w-0",
			"flex-1",
			"flex-col",
			"items-start",
			"gap-2",
		]);
		expect(tokens(within(band).getByText(sharing.bundleFailed))).toEqual([
			"text-sm",
		]);
		const retry = within(band).getByRole("button", {
			name: en.systemLogs.action.retry,
		});
		expect(tokens(retry)).toEqual(
			expect.arrayContaining(["gap-1.5", "h-7", "border-border"]),
		);
		const icon = retry.querySelector("svg");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(icon)).toContain("size-4");
	});

	it("draws a refused creation's band with its own message and no Retry", async () => {
		previewBundle.mockResolvedValue(bundleManifest(3));
		createBundle.mockResolvedValue({ ok: false, error: "READ_FAILED" });
		await open("bundle");
		const body = await dialog(sharing.bundle);
		await within(body).findByRole("table");
		await fireEvent.click(button(body, sharing.bundleDownload));

		const band = await within(body).findByTestId("sharing-bundle-problem");
		expect(tokens(within(band).getByText(sharing.failed))).toEqual(["text-sm"]);
	});
});
