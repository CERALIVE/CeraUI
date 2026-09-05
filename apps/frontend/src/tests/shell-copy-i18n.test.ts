// @vitest-environment jsdom
/**
 * THE SHELL'S LAST TWO HARDCODED OPERATOR STRINGS ARE NOW CATALOG COPY.
 *
 * Two surfaces carried English literals that no locale could reach: the
 * pre-auth connection strip in `Auth.svelte` ("Device connected" / "Connecting…"
 * / "Device unreachable") and the Add-ons entry in `SettingsView.svelte`
 * ("Add-ons" / "Install and manage optional device features"). Neither is a
 * fringe surface — the strip is the FIRST thing an operator reads on a device
 * they cannot sign into, and the Settings entry sits in a list where every
 * neighbour was already translated, so an `ar` session rendered a single Latin
 * row between Arabic ones.
 *
 * No gate could have caught either: the locale-parity gate compares KEY SETS,
 * and a string that was never a key is in perfect parity in all ten catalogs.
 *
 * TWO legs, and both are needed:
 *
 *  · CATALOG — all five keys exist in all ten locales, are non-empty, and are
 *    REAL translations rather than the English value copy-pasted across. `ar` is
 *    additionally required to be non-Latin, which is the script the RTL capture
 *    that found the sibling `noSimLink` defect could actually see.
 *  · RENDERED — the components read those keys. A catalog leg alone passes on a
 *    tree where the literal is still on screen and the key is merely present.
 */

import { render, screen } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { CATALOGS } from "./helpers/catalog";

const KEYS = [
	"connection.connecting",
	"connection.deviceConnected",
	"connection.deviceUnreachable",
	"settings.index.addons",
	"settings.index.addonsDesc",
] as const;

/**
 * Latin script is what an accidental copy-paste looks like inside an Arabic
 * surface, so the check is on the SCRIPT rather than on inequality with `en`:
 * a translation that happens to share a short word with English is not
 * suspicious, and a fully Latin one always is.
 */
const LATIN_LETTER = /[A-Za-z]/;

/** Latin-script locales, where an unnoticed copy-paste is most plausible. */
const MUST_DIFFER_FROM_EN = ["es", "de", "fr", "pt-BR"] as const;

function lookup(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

describe("the shell's connection strip and Add-ons entry are catalog copy", () => {
	for (const key of KEYS) {
		describe(key, () => {
			const english = lookup(CATALOGS.en, key);

			it("ships on en as a non-empty string", () => {
				expect(typeof english).toBe("string");
				expect((english as string).length).toBeGreaterThan(0);
			});

			for (const locale of Object.keys(CATALOGS)) {
				it(`${locale}: resolves to a non-empty string`, () => {
					const value = lookup(CATALOGS[locale as keyof typeof CATALOGS], key);
					expect(typeof value).toBe("string");
					expect((value as string).length).toBeGreaterThan(0);
				});
			}

			for (const locale of MUST_DIFFER_FROM_EN) {
				it(`${locale}: is a real translation, not the English value`, () => {
					expect(lookup(CATALOGS[locale], key)).not.toBe(english);
				});
			}

			it("ar: is written in Arabic script, not Latin", () => {
				expect(lookup(CATALOGS.ar, key) as string).not.toMatch(LATIN_LETTER);
			});
		});
	}
});

const connectionState = vi.hoisted(() => ({ value: "connected" as string }));

vi.mock("$lib/config", () => ({
	deviceName: "CeraLive",
	siteName: "ceralive.tv",
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => undefined,
	getNotifications: () => undefined,
	getConfig: () => ({ autostart: false }),
	getKiosk: () => undefined,
}));

vi.mock("$lib/stores/auth-status.svelte", () => ({
	authenticate: vi.fn(),
	createPassword: vi.fn(),
}));

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	getSessionExpired: () => false,
}));

vi.mock("$lib/stores/offline-state.svelte", () => ({
	getConnectionState: () => connectionState.value,
}));

const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("./fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("../main/dialogs/CloudRemoteDialog.svelte", noop);
vi.mock("../main/dialogs/NetworkIngestDialog.svelte", noop);
vi.mock("../main/dialogs/LogsDialog.svelte", noop);
vi.mock("../main/dialogs/PasswordDialog.svelte", noop);
vi.mock("../main/dialogs/PowerDialog.svelte", noop);
vi.mock("../main/dialogs/SshDialog.svelte", noop);
vi.mock("../main/dialogs/UpdatesDialog.svelte", noop);
vi.mock("../main/dialogs/VersionsDialog.svelte", noop);
vi.mock("../main/settings/AddonsSection.svelte", noop);
vi.mock("../main/settings/DeviceStatsSection.svelte", noop);
vi.mock("../main/settings/OnDeviceDisplaySection.svelte", noop);
vi.mock("../main/settings/RemoteControlStatus.svelte", noop);
vi.mock("$lib/components/custom/LocaleSelector.svelte", noop);
vi.mock("$lib/components/custom/LowDiskBanner.svelte", noop);
vi.mock("$lib/components/custom/mode-toggle.svelte", noop);

const Auth = await import("../main/Auth.svelte");
const SettingsView = await import("../main/SettingsView.svelte");

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
	connectionState.value = "connected";
	localStorage.clear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("the surfaces render those keys", () => {
	it("the pre-auth connection strip reads every state from the catalog", () => {
		for (const [state, key] of [
			["connected", "connection.deviceConnected"],
			["connecting", "connection.connecting"],
			["disconnected", "connection.deviceUnreachable"],
		] as const) {
			connectionState.value = state;
			const view = render(Auth.default);
			const strip = document.querySelector("[data-connection-strip]");
			expect(strip?.textContent?.trim()).toBe(lookup(CATALOGS.en, key));
			view.unmount();
		}
	});

	it("the Add-ons settings entry reads its title and description from the catalog", () => {
		render(SettingsView.default);

		const entry = screen.getByTestId("settings-entry-addons");
		expect(entry.textContent).toContain(
			lookup(CATALOGS.en, "settings.index.addons"),
		);
		expect(entry.textContent).toContain(
			lookup(CATALOGS.en, "settings.index.addonsDesc"),
		);
	});
});
