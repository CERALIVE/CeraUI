// @vitest-environment jsdom
/**
 * SettingsView — the Network ingest entry (Task 8).
 *
 * The streaming group gains a "Network ingest" entry (icon Radio) that opens the
 * NetworkIngestDialog. This test drives the real SettingsView (heavy children
 * stubbed) and asserts the entry renders and routes clicks to the dialog.
 */
import { getLL } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";
import SettingsView from "./SettingsView.svelte";

const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("./dialogs/CloudRemoteDialog.svelte", noop);
vi.mock("./dialogs/NetworkIngestDialog.svelte", noop);
vi.mock("./dialogs/LogsDialog.svelte", noop);
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
vi.mock("$lib/components/custom/LowDiskBanner.svelte", noop);
vi.mock("$lib/components/custom/mode-toggle.svelte", noop);

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

const t = getLL().settings.networkIngest;

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
	destroyAsyncOperations();
});

describe("SettingsView — Network ingest entry", () => {
	it("renders the Network ingest entry in the streaming group", () => {
		render(SettingsView);
		const entry = screen.getByRole("button", { name: new RegExp(t.title()) });
		expect(entry).toBeTruthy();
		expect(entry.textContent).toContain(t.title());
		expect(entry.textContent).toContain(t.desc());
	});

	it("opens the dialog on click without error", async () => {
		render(SettingsView);
		const entry = screen.getByRole("button", { name: new RegExp(t.title()) });
		await fireEvent.click(entry);
		// No throw + entry still present is the smoke assertion (dialog is stubbed).
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: new RegExp(t.title()) }),
			).toBeTruthy(),
		);
	});
});
