// @vitest-environment jsdom
/**
 * ModemConfigDialog — the operator is told about an interruption BEFORE it happens.
 *
 * Operator report: toggling the roaming permission or the automatic-APN switch
 * sent the modem through a fresh search/reconnect cycle. Half the fix is the
 * device spending that reconnect only on a real change (see the backend suite);
 * the other half is here, because for a modem that IS connected the reconnect is
 * genuinely unavoidable — NetworkManager 1.42.4, measured on the board, refuses
 * to reapply any `gsm.*` property to a live bearer. Hiding that would be as
 * dishonest as causing it silently.
 *
 * The negative controls carry the weight: an untouched form and an idle modem
 * must show nothing at all, or the notice becomes noise the operator stops
 * reading.
 */

import { m } from "@ceraui/i18n/svelte";
import type { Modem } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getModemsFeed,
	publishModems,
	resetModemsFeed,
} from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const configure = vi.hoisted(() => vi.fn());
const setConnected = vi.hoisted(() => vi.fn<(next: boolean) => void>());

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { configure, setUsbMode: vi.fn(), scan: vi.fn() } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("../../tests/helpers/modem-feed.svelte");
	const { fromStore, writable } = await import("svelte/store");
	const connected = writable(true);
	const current = fromStore(connected);
	setConnected.mockImplementation(connected.set);
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => ({}),
		getStatus: () => ({}),
		getIsConnected: () => current.current,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

function modem(
	connection: string,
	config: Partial<NonNullable<Modem["config"]>> = {},
): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		network_type: { supported: ["4g3g"], active: "4g3g" },
		status: {
			connection,
			network_type: "4G",
			signal: 72,
			roaming: false,
		},
		config: {
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
			autoconfig: false,
			...config,
		},
	} as Modem;
}

function mount(value: Modem) {
	return render(ModemConfigDialog, {
		props: { open: true, modem: value, deviceId: "2" },
	});
}

function notice(): HTMLElement | null {
	return screen.queryByTestId("modem-reconnect-notice");
}

function roamingSwitch(): HTMLElement {
	return screen.getByRole("switch", { name: /roaming/i });
}

function autoApnSwitch(): HTMLElement {
	return screen.getByRole("switch", { name: /Automatic APN/i });
}

beforeAll(() => {
	// jsdom implements neither, and bits-ui's dialog layers reach for both while
	// a switch inside the content re-renders.
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

describe("the reconnect notice", () => {
	beforeEach(() => {
		resetModemsFeed();
		setConnected(true);
		configure.mockReset();
		configure.mockResolvedValue({ success: true });
	});

	it("says nothing about a form nobody has edited", async () => {
		mount(modem("connected"));
		expect(notice()).toBeNull();
	});

	it("appears when roaming is toggled on a CONNECTED modem", async () => {
		mount(modem("connected"));

		await fireEvent.click(roamingSwitch());

		await waitFor(() => expect(notice()).not.toBeNull());
		expect(notice()?.getAttribute("data-changed")).toContain("roaming");
	});

	it("appears when automatic APN is toggled on a CONNECTED modem", async () => {
		mount(modem("connected"));

		await fireEvent.click(autoApnSwitch());

		await waitFor(() => expect(notice()).not.toBeNull());
		expect(notice()?.getAttribute("data-changed")).toContain("autoconfig");
	});

	it("retracts when the operator puts the toggle back", async () => {
		// Toggling out and back changes nothing NetworkManager would see, so the
		// device spends no reconnect — and the dialog must stop promising one.
		mount(modem("connected"));

		await fireEvent.click(roamingSwitch());
		await waitFor(() => expect(notice()).not.toBeNull());

		await fireEvent.click(roamingSwitch());
		await waitFor(() => expect(notice()).toBeNull());
	});

	it("stays away on a modem that is only SEARCHING", async () => {
		// The board's real state: no bearer is up, so there is nothing to
		// interrupt and nothing to warn about.
		mount(modem("searching"));

		await fireEvent.click(roamingSwitch());

		// The scan affordance only exists while roaming is on, so its arrival is
		// proof the toggle really took — without it this would pass on a dead click.
		await waitFor(() =>
			expect(screen.queryByTestId("modem-scan-button")).not.toBeNull(),
		);
		expect(notice()).toBeNull();
	});

	it("keeps an unsaved draft through a connection loss and the returning modem snapshot", async () => {
		const initial: Modem = {
			...modem("connected"),
			data_usage: { session_bytes: 10, cycle_bytes: 20 },
		};
		publishModems({ "2": initial });
		const { rerender } = mount(initial);
		const apn = () =>
			screen.getByLabelText(m["network.modem.apn"]()) as HTMLInputElement;
		const username = () =>
			screen.getByLabelText(m["network.modem.username"]()) as HTMLInputElement;
		await fireEvent.input(apn(), { target: { value: "draft.apn" } });
		await fireEvent.input(username(), { target: { value: "draft-user" } });

		// Ordinary transport loss retains the last modem snapshot. An empty
		// roster would instead remove the dialog in NetworkView, and logout's
		// resetState is a different lifecycle from this still-mounted edit.
		setConnected(false);
		await tick();
		expect(screen.queryByTestId("modem-usage-stale")).not.toBeNull();
		expect(getModemsFeed()["2"]?.config?.apn).toBe("internet");
		expect(apn().value).toBe("draft.apn");
		expect(username().value).toBe("draft-user");
		expect(configure).not.toHaveBeenCalled();

		// The returning feed reports persisted values, not the unsent draft.
		// Drive the prop update too, as NetworkView's selected roster entry does.
		const returned: Modem = {
			...initial,
			config: { ...initial.config, apn: "device.apn", username: "device-user" },
		};
		setConnected(true);
		publishModems({ "2": returned });
		await rerender({ modem: returned });
		expect(screen.queryByTestId("modem-usage-stale")).toBeNull();
		expect(getModemsFeed()["2"]?.config?.apn).toBe("device.apn");
		expect(apn().value).toBe("draft.apn");
		expect(username().value).toBe("draft-user");
		expect(configure).not.toHaveBeenCalled();

		await fireEvent.click(
			screen.getByRole("button", { name: m["network.modem.save"]() }),
		);
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(configure).toHaveBeenCalledWith(
			expect.objectContaining({
				device: "2",
				apn: "draft.apn",
				username: "draft-user",
			}),
		);
		// Dispatching the edit does not fabricate an accepted device reading.
		expect(getModemsFeed()["2"]?.config?.apn).toBe("device.apn");
	});
});
