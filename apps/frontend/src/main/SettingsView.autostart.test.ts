// @vitest-environment jsdom
/**
 * SettingsView — native-feel async state for the autostart toggle (Todo 14, S7).
 *
 * The autostart AsyncSwitch now routes its `setAutostart` dispatch through the
 * keyed async-operation machine (`osCommand`), which owns the re-entry guard, the
 * in-flight `pending` phase, and the single failure toast; the pessimistic switch
 * reverts on any non-applied outcome. These tests drive the REAL SettingsView
 * (osCommand runs unmocked) with the heavy child dialogs replaced by an inert
 * Noop stub so only the autostart switch + its handler are exercised.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";
import SettingsView from "./SettingsView.svelte";

// --- Heavy children replaced by an inert stub (they each pull a subscription
//     graph we don't need to test the autostart switch). ----------------------
const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("./dialogs/CloudRemoteDialog.svelte", noop);
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

const state = vi.hoisted(() => ({ autostart: false }));
const setAutostart = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/client", () => ({
	rpc: { system: { setAutostart } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ autostart: state.autostart }),
	getKiosk: () => undefined,
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: vi.fn() },
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const autostartSwitch = () =>
	screen.getByTestId("settings-autostart-switch") as HTMLButtonElement;

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

beforeEach(() => {
	state.autostart = false;
	setAutostart.mockReset();
	toastError.mockClear();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("SettingsView — autostart async state", () => {
	it("shows in-flight (switch disabled), blocks re-entry, then adopts the applied value", async () => {
		const d = deferred<{ success: boolean; applied: { autostart: boolean } }>();
		setAutostart.mockReturnValueOnce(d.promise);

		render(SettingsView);
		const sw = autostartSwitch();
		expect(sw.getAttribute("aria-checked")).toBe("false");

		await fireEvent.click(sw); // dispatch 1 → in flight
		await Promise.resolve();
		expect(setAutostart).toHaveBeenCalledOnce();
		await waitFor(() => expect(sw.disabled).toBe(true));

		// Re-entrant toggle while pending must not dispatch a second write.
		await fireEvent.click(sw);
		await Promise.resolve();
		expect(setAutostart).toHaveBeenCalledOnce();

		d.resolve({ success: true, applied: { autostart: true } });
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
	});

	it("reverts and surfaces a failure, then releases re-entry", async () => {
		setAutostart.mockRejectedValue(new Error("boom"));

		render(SettingsView);
		const sw = autostartSwitch();

		await fireEvent.click(sw);
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		// Pessimistic revert: the switch stays on its prior (off) value.
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));

		// Re-entry released by the failure → a retry dispatches again.
		await fireEvent.click(sw);
		await waitFor(() => expect(setAutostart).toHaveBeenCalledTimes(2));
	});
});
