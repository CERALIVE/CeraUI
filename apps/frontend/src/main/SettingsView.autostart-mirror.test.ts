// @vitest-environment jsdom
/**
 * SettingsView — behaviour lock for the autostart switch's CONFIG MIRROR.
 *
 * `SettingsView.autostart.test.ts` covers the dispatch half (in-flight, revert,
 * re-entry) against a static config double. This file covers the other half:
 * the switch position is a projection of the authoritative `config` broadcast,
 * so it must follow a LATE push and must preserve a field an incremental push
 * omits (the ingestion merge is field-preserving, so an omitted `autostart` is
 * "no verdict this tick", never `false`).
 *
 * Green on the pre-change tree — this is a refactor lock for the
 * store-into-state mirror at `SettingsView.svelte:110`, not a bug fix.
 */
import { render, screen, waitFor } from "@testing-library/svelte";
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
import {
	publishConfig,
	resetConfigFeed,
} from "./__fixtures__/settings-config-feed.svelte";
import SettingsView from "./SettingsView.svelte";

// Heavy children replaced by an inert stub — each pulls a subscription graph
// that has nothing to do with the autostart projection.
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

const setAutostart = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/client", () => ({
	rpc: { system: { setAutostart } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("./__fixtures__/settings-config-feed.svelte");
	return {
		getConfig: feed.getConfigFeed,
		getKiosk: () => undefined,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

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
	resetConfigFeed();
	setAutostart.mockReset();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("SettingsView — the autostart switch mirrors the config broadcast", () => {
	it("renders off before any config has arrived", () => {
		render(SettingsView);
		expect(autostartSwitch().getAttribute("aria-checked")).toBe("false");
	});

	it("adopts the value the first config broadcast carries", async () => {
		publishConfig({ autostart: true } as never);
		render(SettingsView);
		await waitFor(() =>
			expect(autostartSwitch().getAttribute("aria-checked")).toBe("true"),
		);
	});

	it("follows a LATE broadcast in both directions", async () => {
		render(SettingsView);
		const sw = autostartSwitch();
		expect(sw.getAttribute("aria-checked")).toBe("false");

		publishConfig({ autostart: true } as never);
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));

		publishConfig({ autostart: false } as never);
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
	});

	it("keeps the last verdict when a push omits the field", async () => {
		publishConfig({ autostart: true } as never);
		render(SettingsView);
		const sw = autostartSwitch();
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));

		// The ingestion merge preserves an omitted field, so `getConfig()` still
		// carries `autostart` — the projection must not read absence as `false`.
		publishConfig({ autostart: true, max_br: 4000 } as never);
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
	});

	it("never dispatches a write from the mirror alone", async () => {
		render(SettingsView);
		publishConfig({ autostart: true } as never);
		await waitFor(() =>
			expect(autostartSwitch().getAttribute("aria-checked")).toBe("true"),
		);
		expect(setAutostart).not.toHaveBeenCalled();
	});
});
