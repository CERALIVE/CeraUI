// @vitest-environment jsdom
import type { LogExportOutput } from "@ceraui/rpc/schemas";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
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

import { fourBoots } from "$lib/device-logs/__fixtures__/boots";
import { eventPage } from "$lib/device-logs/__fixtures__/events";
import { EXPORT_TICKET } from "$lib/device-logs/__fixtures__/sharing";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";
import { deliverLegacyLog } from "$lib/device-logs/download-gate.svelte";
import { getDeviceLog } from "$lib/helpers/SystemHelper";
import {
	clearRequestedDialog,
	requestDialog,
} from "$lib/stores/dialog-request.svelte";
import { navigateTo, resetNavigation } from "$lib/stores/navigation.svelte";

import { en } from "../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../tests/helpers/media-query";

import SettingsView from "./SettingsView.svelte";

/**
 * Leaving Settings is an exit from System Logs: a reply the open view still
 * waits on (an Export ticket, a legacy log file) that lands around the route
 * change starts no download. The real Settings view, the real System Logs
 * dialog it lazily loads, and the real router.
 */

const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("./dialogs/CloudRemoteDialog.svelte", noop);
vi.mock("./dialogs/NetworkIngestDialog.svelte", noop);
vi.mock("./dialogs/PasswordDialog.svelte", noop);
vi.mock("./dialogs/PowerDialog.svelte", noop);
vi.mock("./dialogs/SshDialog.svelte", noop);
vi.mock("./dialogs/UpdatesDialog.svelte", noop);
vi.mock("./dialogs/VersionsDialog.svelte", noop);
vi.mock("./settings/AddonsSection.svelte", noop);
vi.mock("./settings/DeviceStatsSection.svelte", noop);
vi.mock("./settings/OnDeviceDisplaySection.svelte", noop);
vi.mock("./settings/RemoteControlStatus.svelte", noop);
vi.mock("$lib/components/custom/LocaleSelector.svelte", noop);
vi.mock("$lib/components/custom/LowDiskBanner.svelte", async () => ({
	default: (await import("../tests/fixtures/LowDiskBannerStub.svelte")).default,
}));
vi.mock("$lib/components/custom/mode-toggle.svelte", noop);
vi.mock("$lib/stores/navigation-lazy", () => ({
	navigateToDestination: vi.fn(),
}));

const rpc = vi.hoisted(() => {
	const tickets = { sent: 0, reply: Promise.withResolvers<LogExportOutput>() };
	return {
		tickets,
		system: { setAutostart: vi.fn() },
		logs: {
			getStorage: vi.fn(),
			boots: vi.fn(),
			query: vi.fn(),
			previewBundle: vi.fn(),
			// A plain function, not a mock: a mock's own bookkeeping adds a promise
			// step between the device's reply and the flow.
			createExport: () => {
				tickets.sent += 1;
				return tickets.reply.promise;
			},
		},
		events: { list: vi.fn() },
	};
});
vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	getConfig: () => ({ autostart: false }),
	getKiosk: () => undefined,
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
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const sharing = en.systemLogs.sharing;
const MAX_HOPS = 8;

let media: MediaQueryControl | undefined;
let anchorClicks: ReturnType<typeof vi.spyOn>;

function leaveSettings(): void {
	navigateTo({ network: { label: "network", component: SettingsView } });
}

async function openLogs(): Promise<void> {
	resetNavigation();
	requestDialog("logs");
	await screen.findByTestId("sharing-toolbar-export");
}

beforeAll(async () => {
	await Promise.all([
		import("./dialogs/LogsDialog.svelte"),
		import("./system-logs/EventsTab.svelte"),
	]);
});

beforeEach(() => {
	vi.clearAllMocks();
	media = installMediaQueries((query) => query === "(min-width: 1024px)");
	rpc.logs.getStorage.mockResolvedValue({});
	rpc.logs.boots.mockResolvedValue(fourBoots());
	rpc.logs.query.mockResolvedValue({ ok: false, error: "READ_FAILED" });
	rpc.events.list.mockResolvedValue(eventPage([]));
	anchorClicks = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => {});
	Object.assign(URL, {
		createObjectURL: vi.fn(() => "blob:log"),
		revokeObjectURL: vi.fn(),
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	clearRequestedDialog();
	resetNavigation();
	bootSelection.reset();
	media?.restore();
	media = undefined;
	vi.restoreAllMocks();
});

describe("SettingsView: leaving Settings while System Logs waits on a reply", () => {
	it("an Export ticket answered around the route change starts no download after it", async () => {
		render(SettingsView);
		const late: number[] = [];
		for (let hops = 0; hops <= MAX_HOPS; hops++) {
			await openLogs();
			rpc.tickets.sent = 0;
			rpc.tickets.reply = Promise.withResolvers<LogExportOutput>();
			await fireEvent.click(screen.getByTestId("sharing-toolbar-export"));
			const dialog = await screen.findByRole("dialog", {
				name: sharing.export,
			});
			await fireEvent.click(
				within(dialog).getByRole("button", { name: sharing.exportDownload }),
			);
			await waitFor(() => expect(rpc.tickets.sent).toBe(1));
			let left = false;
			let downloadedAfter = false;
			anchorClicks.mockImplementation(() => {
				if (left) downloadedAfter = true;
			});

			rpc.tickets.reply.resolve(EXPORT_TICKET);
			let hop = Promise.resolve();
			for (let i = 0; i < hops; i++) hop = hop.then(() => {});
			void hop.then(() => {
				left = true;
				leaveSettings();
			});
			// A task boundary: every continuation queued by the reply and the route change has run.
			await new Promise((resolve) => setTimeout(resolve));

			if (downloadedAfter) late.push(hops);
		}
		expect(late).toEqual([]);
	});

	it("a legacy log file pushed after the route change is not saved", async () => {
		render(SettingsView);
		await openLogs();
		const pushed = Promise.withResolvers<boolean>();
		vi.mocked(getDeviceLog).mockImplementation((request?: string) => {
			leaveSettings();
			pushed.resolve(
				deliverLegacyLog({
					name: "ceralive_log.txt",
					contents: "log",
					request,
				}),
			);
			return Promise.resolve();
		});

		await fireEvent.click(await screen.findByTestId("log-download-device"));

		expect(await pushed.promise).toBe(false);
		expect(anchorClicks).not.toHaveBeenCalled();
	});
});
