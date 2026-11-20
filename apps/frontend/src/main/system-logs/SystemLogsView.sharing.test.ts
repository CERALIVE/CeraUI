// @vitest-environment jsdom
import type {
	LogBundleManifest,
	LogExportInput,
	LogExportOutput,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	bundleManifest,
	EXPORT_TICKET,
	signalled,
} from "$lib/device-logs/__fixtures__/sharing";
import { notifyHistoryChanged } from "$lib/device-logs/history-bus";
import { getBackendHttpUrl } from "$lib/env";
import { RpcError } from "$lib/rpc/rpc-error";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import SystemLogsView from "./SystemLogsView.svelte";

const logs = vi.hoisted(() => ({
	getStorage: vi.fn<() => Promise<unknown>>(),
	createExport: vi.fn<(input: LogExportInput) => Promise<LogExportOutput>>(),
	previewBundle: vi.fn<() => Promise<LogBundleManifest>>(),
	createBundle: vi.fn<() => Promise<LogExportOutput>>(),
}));
const rpc = vi.hoisted(() => ({}) as { logs?: typeof logs });
const ensureNamespaces = vi.hoisted(() =>
	vi.fn<(namespaces: readonly string[]) => Promise<void>>(),
);

vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));
vi.mock(
	"@ceraui/i18n/svelte",
	async (
		importOriginal: () => Promise<typeof import("@ceraui/i18n/svelte")>,
	) => ({
		...(await importOriginal()),
		ensureNamespaces,
	}),
);

const WIDE = "(min-width: 1024px)";
let media: MediaQueryControl | undefined;
let anchorClicks: ReturnType<typeof vi.spyOn>;

function viewport(wide: boolean): void {
	media = installMediaQueries((query) => query === WIDE && wide);
}

beforeEach(() => {
	rpc.logs = logs;
	for (const call of Object.values(logs)) call.mockReset();
	logs.getStorage.mockResolvedValue({});
	ensureNamespaces.mockReset();
	ensureNamespaces.mockResolvedValue(undefined);
	anchorClicks = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	media?.restore();
	media = undefined;
	vi.restoreAllMocks();
});

const sharing = en.systemLogs.sharing;

// The flow handles a reply a few promise hops after it lands; a bounded drain lets
// a late reply arrive before asserting that it changed nothing. Never timed.
async function drain(): Promise<void> {
	for (let turn = 0; turn < 100; turn++) await Promise.resolve();
}

async function openBundle(): Promise<HTMLElement> {
	await fireEvent.click(await screen.findByTestId("sharing-open-bundle"));
	return screen.findByRole("dialog", { name: sharing.bundle });
}

describe("SystemLogsView: Sharing in the Downloads region", () => {
	it("leads the Downloads region with the Sharing group once the viewer is ready", async () => {
		viewport(true);
		const probe = Promise.withResolvers<unknown>();
		logs.getStorage.mockReturnValue(probe.promise);
		render(SystemLogsView);
		expect(screen.getByTestId("log-row-device")).toBeTruthy();
		expect(screen.queryByTestId("sharing-group")).toBeNull();

		probe.resolve({});
		const group = await screen.findByTestId("sharing-group");

		const downloads = within(
			screen.getByTestId("system-logs-side"),
		).getByTestId("system-logs-downloads");
		expect(downloads.contains(group)).toBe(true);
		expect(
			group.compareDocumentPosition(screen.getByTestId("log-row-device")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("puts the Sharing group in the Storage tab on a narrow screen", async () => {
		viewport(false);
		render(SystemLogsView);
		await screen.findByRole("tablist");
		expect(screen.queryByTestId("sharing-group")).toBeNull();

		await fireEvent.click(
			screen.getByRole("tab", { name: en.systemLogs.tabs.storage }),
		);

		const panel = screen.getByTestId("system-logs-panel-storage");
		expect(within(panel).getByTestId("sharing-group")).toBeTruthy();
	});

	it("leaves the Sharing group out for a device version without the log viewer", async () => {
		viewport(true);
		logs.getStorage.mockRejectedValue(
			new RpcError({
				message: "Unknown procedure path: logs.getStorage",
				code: "INTERNAL_ERROR",
			}),
		);
		render(SystemLogsView);

		await screen.findByTestId("system-logs-unavailable");
		expect(screen.getByTestId("log-row-device")).toBeTruthy();
		expect(screen.queryByTestId("sharing-group")).toBeNull();
	});
});

describe("SystemLogsView: Sharing downloads", () => {
	it("hands an export ticket to the browser on the backend origin", async () => {
		viewport(true);
		logs.createExport.mockResolvedValue(EXPORT_TICKET);
		const clicked = Promise.withResolvers<string>();
		anchorClicks.mockImplementation(function (this: HTMLAnchorElement) {
			clicked.resolve(this.href);
		});
		render(SystemLogsView);
		await fireEvent.click(await screen.findByTestId("sharing-open-export"));
		const body = await screen.findByRole("dialog", { name: sharing.export });

		await fireEvent.click(
			within(body).getByRole("button", { name: sharing.exportDownload }),
		);

		expect(await signalled(clicked.promise, "the download")).toBe(
			getBackendHttpUrl(EXPORT_TICKET.url),
		);
	});
});

describe("SystemLogsView: Sharing state belongs to the open view", () => {
	it("keeps a bundle preview in flight when Downloads moves across the 1024 px breakpoint", async () => {
		viewport(true);
		const preview = Promise.withResolvers<LogBundleManifest>();
		logs.previewBundle.mockReturnValue(preview.promise);
		render(SystemLogsView);
		await openBundle();

		media?.set(() => false);
		await fireEvent.click(
			await screen.findByRole("tab", { name: en.systemLogs.tabs.storage }),
		);
		const body = await screen.findByRole("dialog", { name: sharing.bundle });
		expect(within(body).getByTestId("sharing-bundle-loading")).toBeTruthy();
		preview.resolve(bundleManifest(3));

		expect(await within(body).findByRole("table")).toBeTruthy();
		expect(logs.previewBundle).toHaveBeenCalledTimes(1);
	});

	it("discards a bundle preview and stops listening for deleted history once the view closes", async () => {
		viewport(true);
		const preview = Promise.withResolvers<LogBundleManifest>();
		logs.previewBundle.mockReturnValue(preview.promise);
		const view = render(SystemLogsView);
		await openBundle();

		view.unmount();
		preview.resolve(bundleManifest(3));
		await drain();
		notifyHistoryChanged();

		expect(logs.previewBundle).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("starts no download for an export ticket that lands after the view closed", async () => {
		viewport(true);
		const ticket = Promise.withResolvers<LogExportOutput>();
		logs.createExport.mockReturnValue(ticket.promise);
		const view = render(SystemLogsView);
		await fireEvent.click(await screen.findByTestId("sharing-open-export"));
		const body = await screen.findByRole("dialog", { name: sharing.export });
		await fireEvent.click(
			within(body).getByRole("button", { name: sharing.exportDownload }),
		);
		expect(logs.createExport).toHaveBeenCalledTimes(1);

		view.unmount();
		ticket.resolve(EXPORT_TICKET);
		await drain();

		expect(anchorClicks).not.toHaveBeenCalled();
	});
});
