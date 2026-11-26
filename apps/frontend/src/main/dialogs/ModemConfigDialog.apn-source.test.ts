// @vitest-environment jsdom
/**
 * ModemConfigDialog: a chosen APN says where it came from.
 *
 * When the backend fills a new profile's APN from the mobile provider database
 * (because Automatic APN would have used another network's APN), or leaves
 * Automatic APN on for a SIM the database does not list, the dialog states it
 * on screen so the operator knows the value can be wrong and can correct it.
 * Each note disappears as soon as the form no longer matches what the backend
 * described, and a backend that sends no `apn_source` renders exactly as before.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetModemsFeed } from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const configure = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { configure, setUsbMode: vi.fn(), scan: vi.fn() } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("../../tests/helpers/modem-feed.svelte");
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => ({}),
		getStatus: () => ({}),
		getIsConnected: () => true,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

type WireModemConfig = NonNullable<Modem["config"]>;

function modemWithConfig(config: Partial<WireModemConfig>): Modem {
	return {
		ifname: "wwan0",
		name: "Fibocom FM350-GL",
		network_type: { supported: ["4g", "5g"], active: "4g" },
		status: {
			connection: "registered",
			network_type: "4g",
			signal: 60,
			roaming: false,
		},
		config: {
			apn: "internet",
			username: "",
			password: "",
			roaming: true,
			network: "",
			autoconfig: false,
			autoconfig_supported: true,
			...config,
		},
	} as Modem;
}

function mount(modem: Modem) {
	return render(ModemConfigDialog, {
		props: { open: true, modem, deviceId: "1" },
	});
}

function autoApnSwitch(): HTMLElement {
	return screen.getByRole("switch", { name: /Automatic APN/i });
}

beforeAll(() => {
	// jsdom has no Web Animations; the manual APN section slides in when the
	// switch flips, as in the sibling reconnect suite.
	if (!Element.prototype.animate) {
		Element.prototype.animate = vi.fn().mockReturnValue({
			cancel: vi.fn(),
			finish: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}) as unknown as Element["animate"];
	}
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
	configure.mockReset();
	configure.mockResolvedValue({ success: true });
	resetModemsFeed();
});

describe("an APN filled in from the provider database", () => {
	it("is labelled under the APN field", async () => {
		mount(
			modemWithConfig({
				apn: "vzwinternet",
				apn_source: "provider-database",
			}),
		);

		const note = await screen.findByTestId("modem-apn-from-provider-database");
		expect(note.textContent).toMatch(/provider database/i);
		expect(
			document.querySelector("#modem-apn")?.getAttribute("aria-describedby"),
		).toBe(note.id);
	});

	it("loses the label once the operator types another APN", async () => {
		mount(
			modemWithConfig({
				apn: "vzwinternet",
				apn_source: "provider-database",
			}),
		);
		await screen.findByTestId("modem-apn-from-provider-database");

		const input = document.querySelector<HTMLInputElement>("#modem-apn");
		if (input === null) throw new Error("manual APN field is not mounted");
		await fireEvent.input(input, { target: { value: "ereseller" } });

		await waitFor(() =>
			expect(
				screen.queryByTestId("modem-apn-from-provider-database"),
			).toBeNull(),
		);
	});

	it("is not labelled when the backend says nothing about the source", async () => {
		mount(modemWithConfig({ apn: "vzwinternet" }));

		await waitFor(() =>
			expect(document.querySelector("#modem-apn")).toBeTruthy(),
		);
		expect(screen.queryByTestId("modem-apn-from-provider-database")).toBeNull();
	});
});

describe("a SIM the provider database does not list", () => {
	it("says so beside Automatic APN", async () => {
		mount(
			modemWithConfig({ autoconfig: true, apn: "", apn_source: "not-listed" }),
		);

		const note = await screen.findByTestId("modem-apn-not-listed");
		expect(note.textContent).toMatch(/no internet APN/i);
		// Reached from the switch itself, not only when reading the page.
		expect(autoApnSwitch().getAttribute("aria-describedby")).toBe(note.id);
	});

	it("drops the note when Automatic APN is switched off", async () => {
		mount(
			modemWithConfig({ autoconfig: true, apn: "", apn_source: "not-listed" }),
		);
		await screen.findByTestId("modem-apn-not-listed");

		await fireEvent.click(autoApnSwitch());

		await waitFor(() =>
			expect(screen.queryByTestId("modem-apn-not-listed")).toBeNull(),
		);
	});

	it("shows no note without a source", async () => {
		mount(modemWithConfig({ autoconfig: true, apn: "" }));

		await waitFor(() => expect(autoApnSwitch()).toBeTruthy());
		expect(screen.queryByTestId("modem-apn-not-listed")).toBeNull();
	});
});
