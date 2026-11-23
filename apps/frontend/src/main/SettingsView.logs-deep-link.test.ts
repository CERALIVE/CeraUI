// @vitest-environment jsdom
import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";
import {
	clearRequestedDialog,
	getRequestedDialog,
	requestDialog,
} from "$lib/stores/dialog-request.svelte";
import { navigateTo, resetNavigation } from "$lib/stores/navigation.svelte";

import SettingsView from "./SettingsView.svelte";

const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("./dialogs/CloudRemoteDialog.svelte", noop);
vi.mock("./dialogs/NetworkIngestDialog.svelte", noop);
vi.mock("./dialogs/LogsDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/LogsDialogProbe.svelte")).default,
}));
vi.mock("./dialogs/PasswordDialog.svelte", noop);
vi.mock("./dialogs/PowerDialog.svelte", noop);
vi.mock("./dialogs/SshDialog.svelte", noop);
vi.mock("./dialogs/UpdatesDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/UpdatesDialogProbe.svelte"))
		.default,
}));
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

vi.mock("$lib/rpc/client", () => ({
	rpc: { system: { setAutostart: vi.fn() } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ autostart: false }),
	getKiosk: () => undefined,
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

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

afterEach(() => {
	clearRequestedDialog();
	destroyAsyncOperations();
});

async function probe(): Promise<{ open: string; context: unknown }> {
	const node = await screen.findByTestId("logs-dialog-probe");
	return {
		open: node.dataset.open ?? "",
		context: JSON.parse(node.dataset.context ?? "null"),
	};
}

describe("SettingsView: System Logs entry", () => {
	it("describes the System Logs view rather than the old log downloads", () => {
		render(SettingsView);

		const entry = screen.getByRole("button", {
			name: new RegExp(m["settings.index.logs"]()),
		});
		expect(
			within(entry).getByText(m["settings.index.logsViewerDesc"]()),
		).toBeTruthy();
		expect(
			within(entry).queryByText(m["settings.index.logsDesc"]()),
		).toBeNull();
	});
});

describe("SettingsView: System Logs deep links", () => {
	it("opens the Logs dialog with the requested context and consumes the request", async () => {
		render(SettingsView);
		requestDialog("logs", { tab: "raw", at: 1_700_000_000_000 });

		await expect.poll(probe).toEqual({
			open: "true",
			context: { tab: "raw", at: 1_700_000_000_000 },
		});
		expect(getRequestedDialog()).toBeUndefined();
		expect(screen.queryByTestId("updates-dialog-probe")).toBeNull();
	});

	it("opens on Storage from the low-disk banner", async () => {
		render(SettingsView);

		await fireEvent.click(screen.getByTestId("low-disk-view-logs"));

		await expect
			.poll(probe)
			.toEqual({ open: "true", context: { tab: "storage" } });
	});

	it("opens with no context from the Settings entry, even after a deep link", async () => {
		render(SettingsView);
		requestDialog("logs", { tab: "raw", at: 5 });
		await expect.poll(probe).toMatchObject({ open: "true" });

		await fireEvent.click(
			screen.getByRole("button", {
				name: new RegExp(m["settings.index.logs"]()),
			}),
		);

		await expect.poll(probe).toEqual({ open: "true", context: null });
	});

	it("opens the Updates dialog, and not Logs, for an updates-dialog request", async () => {
		render(SettingsView);
		requestDialog("updates-dialog");

		const updates = await screen.findByTestId("updates-dialog-probe");
		expect(updates.dataset.open).toBe("true");
		expect(getRequestedDialog()).toBeUndefined();
		expect(screen.queryByTestId("logs-dialog-probe")).toBeNull();
	});
});

describe("SettingsView: leaving Settings", () => {
	afterEach(() => resetNavigation());

	it("closes System Logs in the same call that changes the route, before Settings is torn down", async () => {
		render(SettingsView);
		requestDialog("logs", { tab: "raw", at: 5 });
		await expect.poll(probe).toMatchObject({ open: "true" });

		navigateTo({ network: { label: "network", component: SettingsView } });
		flushSync();

		expect(screen.getByTestId("logs-dialog-probe").dataset.open).toBe("false");
	});
});
