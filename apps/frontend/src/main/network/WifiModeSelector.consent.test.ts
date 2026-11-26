// @vitest-environment jsdom
/**
 * No access point starts from a client radio without the credential question,
 * whichever of two witnesses says the radio is a client: the mode on screen, or
 * the radio's own pushed row. The shown mode comes from a pulled answer and can
 * outlive the access point it names, so on its own it let Hybrid start one
 * without showing its name and password.
 *
 * Mounted through the real surfaces (the Wi-Fi row's popover and the hotspot
 * dialog) with the real subscription consumer, so a frame reaches the gate the
 * way a device's does.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	NetifMessage,
	WifiAdapterMode,
	WifiInterface,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	destroyAsyncOperations,
	getOperationPhase,
	getOperationReason,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { noteLinkState } from "$lib/rpc/session-epoch.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { setWifiAdapterModesForTest } from "$lib/rpc/wifi-adapter-modes.svelte";
import HotspotDialog from "$main/dialogs/HotspotDialog.svelte";

import WifiSection from "./WifiSection.svelte";
import * as wifiEntryRequest from "./wifi-entry-request";
import { wifiModeOpKey } from "./wifi-station-lock";

const wire = vi.hoisted(() => ({
	message: (_type: string, _data: unknown) => {},
}));
vi.mock("$lib/rpc/client", async () => ({
	ConnectionResetError: (
		await vi.importActual<typeof import("$lib/rpc/client")>("$lib/rpc/client")
	).ConnectionResetError,
	rpc: {
		network: { configure: vi.fn() },
		wifi: {
			hotspotPrepare: vi.fn(),
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			hotspotConfigure: vi.fn(),
			getAdapterModes: vi.fn(),
			setAdapterMode: vi.fn(),
		},
	},
	rpcClient: {
		onMessage: (fn: typeof wire.message) => {
			wire.message = fn;
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getConnectionState: () => "connected",
		getSocket: () => undefined,
		sendLegacy: () => {},
	},
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "") } }));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const mode = vi.mocked(rpc.wifi.setAdapterMode);
const prepare = vi.mocked(rpc.wifi.hotspotPrepare);
const answer = vi.mocked(rpc.wifi.getAdapterModes);
const unobserved = {
	success: false,
	error: "radio-changed",
	reason: "current-unobserved",
} as const;

type RowState = "station" | "hotspot" | "hybrid" | "unstated";

/** A device row. `unstated` is one from a device that predates `mode`. */
function row(state: RowState, incarnation = "radio-A"): WifiInterface {
	const broadcasting = state === "hotspot" || state === "hybrid";
	return {
		ifname: "wlan0",
		hw: "hw",
		conn: "Home",
		incarnation,
		saved: {},
		supports_hotspot: true,
		supports_ap_sta_concurrency: true,
		...(state === "hotspot"
			? {}
			: {
					available: [
						{
							active: true,
							ssid: "Home",
							signal: 70,
							security: "WPA2",
							freq: 5200,
						},
					],
				}),
		...(state === "unstated"
			? {}
			: { mode: state === "hotspot" ? "hotspot" : "station" }),
		...(broadcasting
			? {
					hotspot: { name: "AP", password: "password", available_channels: {} },
				}
			: {}),
	};
}

/** The device's last pulled answer: the mode it puts on screen. */
function label(shown: WifiAdapterMode, ...devices: string[]) {
	const modes = Object.fromEntries(
		(devices.length ? devices : ["0"]).map((device) => [
			device,
			{
				ifname: "wlan0",
				mode: shown,
				options: (["station", "hotspot", "hybrid"] as const).map((offered) => ({
					mode: offered,
					available: true,
				})),
			},
		]),
	);
	answer.mockResolvedValue(modes);
	setWifiAdapterModesForTest(modes);
}

/** The mounted Wi-Fi section; `push` delivers a frame the way a device's lands. */
function section(
	radios: [string, WifiInterface][],
	netif: NetifMessage = { wlan0: { tp: 0, enabled: true } },
) {
	const props = (next: [string, WifiInterface][]) => ({
		wifiRadios: next,
		netif,
		isFullyStale: false,
		staleInterfaces: new Set<string>(),
		onConnect: vi.fn(),
		onOpenCountry: vi.fn(),
	});
	wire.message("status", { wifi: Object.fromEntries(radios) });
	const mounted = render(WifiSection, { props: props(radios) });
	return {
		push: async (next: [string, WifiInterface][]) => {
			wire.message("status", { wifi: Object.fromEntries(next) });
			await mounted.rerender(props(next));
		},
	};
}

async function open(device = "0") {
	const trigger = document.querySelector<HTMLElement>(
		`[data-testid="open-wifi-mode"][data-device="${device}"]`,
	);
	if (!trigger) throw new Error("the Mode affordance is not rendered");
	await fireEvent.click(trigger);
	await tick();
}

const rung = (chosen: WifiAdapterMode, device = "0") =>
	screen.getByTestId<HTMLButtonElement>(`wifi-mode-option-${device}-${chosen}`);
const asked = () => screen.queryByTestId("hotspot-activation-confirm");
const warned = () => screen.queryByTestId("wifi-mode-confirm-0");
const shown = () => screen.getByTestId("wifi-mode-selector").dataset.mode;

async function choose(chosen: WifiAdapterMode, device = "0") {
	await fireEvent.click(rung(chosen, device));
	await tick();
}

async function ready() {
	await waitFor(() => expect(asked()?.dataset.phase).toBe("ready"));
}

async function acknowledge() {
	await ready();
	await fireEvent.click(screen.getByTestId("hotspot-confirm-ack"));
}

async function answerQuestion() {
	await acknowledge();
	await fireEvent.click(screen.getByTestId("hotspot-confirm-activate"));
	await tick();
}

const confirmDisabled = () =>
	screen.getByTestId<HTMLButtonElement>("hotspot-confirm-activate").disabled;

beforeAll(() => {
	window.matchMedia ??= vi.fn().mockImplementation((query: string) => ({
		matches: true,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
});

beforeEach(() => {
	vi.resetAllMocks();
	resetState();
	initAsyncOperations();
	initSubscriptions();
	noteLinkState("disconnected");
	noteLinkState("connected");
	prepare.mockImplementation(async (request) => ({
		success: true,
		name: request.name ?? `${request.incarnation}-stored`,
		password: request.password ?? "stored-password",
	}));
	mode.mockResolvedValue({ success: true, accepted: true });
	answer.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	destroyAsyncOperations();
	resetState();
});

describe("a stale label over a radio that is really a client", () => {
	it("asks before Hybrid when the row says Station under a Hotspot label", async () => {
		label("hotspot");
		section([["0", row("station")]]);
		await open();
		expect(shown()).toBe("hotspot");

		await choose("hybrid");
		expect(mode).not.toHaveBeenCalled();
		await ready();
		expect(confirmDisabled()).toBe(true);

		await answerQuestion();
		expect(mode).toHaveBeenCalledTimes(1);
		expect(mode).toHaveBeenCalledWith({
			device: "0",
			mode: "hybrid",
			incarnation: "radio-A",
		});
	});

	it("asks in the hotspot dialog too, and Cancel starts nothing", async () => {
		label("hotspot");
		render(HotspotDialog, { open: true, deviceId: "0", iface: row("station") });

		await choose("hybrid");
		expect(mode).not.toHaveBeenCalled();
		await ready();
		// One question at a time: the dialog's own Enable waits for this one.
		expect(
			screen.getByRole<HTMLButtonElement>("button", { name: "Enable Hotspot" })
				.disabled,
		).toBe(true);

		await fireEvent.click(screen.getByTestId("hotspot-confirm-cancel"));
		expect(asked()).toBeNull();
		expect(mode).not.toHaveBeenCalled();
	});

	it("asks, with the uplink warning inside, before Hotspot under a Hybrid label", async () => {
		label("hybrid");
		section([["0", row("station")]]);
		await open();

		await choose("hotspot");
		await ready();
		expect(warned()).toBeNull();
		expect(asked()?.textContent).toContain(
			m["network.wifiMode.confirm.dropsUplinkBody"](),
		);
		expect(mode).not.toHaveBeenCalled();

		await answerQuestion();
		expect(mode).toHaveBeenCalledTimes(1);
		expect(mode).toHaveBeenCalledWith({
			device: "0",
			mode: "hotspot",
			incarnation: "radio-A",
		});
	});
});

describe("the question by label, row, live link and choice", () => {
	type Outcome = "asks" | "warns" | "sends" | "nothing";
	// Label, row, station link, then what choosing each mode does. Every cell but
	// the four `asks` under a Hotspot or Hybrid label is what the label alone gave.
	const TABLE: [
		WifiAdapterMode,
		RowState,
		"live" | "down",
		station: Outcome,
		hotspot: Outcome,
		hybrid: Outcome,
	][] = [
		["station", "station", "live", "nothing", "asks", "asks"],
		["station", "station", "down", "nothing", "asks", "asks"],
		["station", "unstated", "live", "nothing", "asks", "asks"],
		["hotspot", "station", "live", "sends", "nothing", "asks"],
		["hotspot", "station", "down", "sends", "nothing", "asks"],
		["hotspot", "hotspot", "down", "warns", "nothing", "sends"],
		["hotspot", "hybrid", "live", "warns", "nothing", "sends"],
		["hotspot", "unstated", "live", "sends", "nothing", "sends"],
		["hybrid", "station", "live", "sends", "asks", "nothing"],
		["hybrid", "station", "down", "sends", "asks", "nothing"],
		["hybrid", "hybrid", "live", "warns", "warns", "nothing"],
		["hybrid", "hybrid", "down", "warns", "sends", "nothing"],
		["hybrid", "unstated", "live", "sends", "warns", "nothing"],
		["hybrid", "unstated", "down", "sends", "sends", "nothing"],
	];

	for (const [from, state, link, ...outcomes] of TABLE)
		for (const [index, chosen] of (
			["station", "hotspot", "hybrid"] as const
		).entries())
			it(`${from} label, ${state} row, ${link} link, choose ${chosen}: ${outcomes[index]}`, async () => {
				label(from);
				const iface = row(state);
				section([["0", link === "live" ? iface : { ...iface, conn: "" }]], {
					wlan0: { tp: 0, enabled: link === "live" },
				});
				await open();
				expect(shown()).toBe(from);
				await choose(chosen);
				expect(asked() !== null).toBe(outcomes[index] === "asks");
				expect(warned() !== null).toBe(outcomes[index] === "warns");
				expect(mode).toHaveBeenCalledTimes(outcomes[index] === "sends" ? 1 : 0);
			});
});

describe("what the question leaves alone", () => {
	for (const [chosen, state] of [
		["hotspot", "hybrid"],
		["station", "hotspot"],
	] as const)
		it(`sends ${chosen} from the inline confirm of a working ${state} radio`, async () => {
			label(state);
			section([["0", row(state)]]);
			await open();
			await choose(chosen);
			await fireEvent.click(screen.getByTestId("wifi-mode-confirm-apply-0"));
			expect(asked()).toBeNull();
			expect(mode).toHaveBeenCalledTimes(1);
			expect(mode).toHaveBeenCalledWith({
				device: "0",
				mode: chosen,
				incarnation: "radio-A",
			});
		});

	for (const [proof, phase, change] of [
		["unidentified", "unsupported", { incarnation: undefined }],
		["degraded", "unverified", { degraded_reason: "unavailable" }],
	] as const)
		it(`still explains why an ${proof} hotspot radio cannot change`, async () => {
			label("hotspot");
			const iface = { ...row("hotspot"), ...change };
			render(HotspotDialog, { open: true, deviceId: "0", iface });
			await choose("hybrid");
			await waitFor(() => expect(asked()?.dataset.phase).toBe(phase));
			expect(mode).not.toHaveBeenCalled();
		});
});

describe("frames that land between the choice and the start", () => {
	it("asks on the inline confirm when the access point ended after it was armed", async () => {
		label("hybrid");
		const view = section([["0", row("hybrid")]]);
		await open();
		await choose("hotspot");
		const apply = screen.getByTestId("wifi-mode-confirm-apply-0");
		apply.focus();

		await view.push([["0", row("station")]]);
		expect(warned()?.dataset.consequence).toBe("drops-uplink");
		await fireEvent.click(apply);
		expect(mode).not.toHaveBeenCalled();
		await ready();
		expect(warned()).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByTestId("hotspot-confirm-cancel"),
		);

		await answerQuestion();
		expect(mode).toHaveBeenCalledTimes(1);
	});

	it("does not resend an unanswered change once the row says Station", async () => {
		label("hotspot");
		mode.mockResolvedValueOnce(unobserved);
		const view = section([["0", row("hotspot")]]);
		await open();
		await choose("hybrid");
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();

		await view.push([["0", row("station")]]);
		await ready();
		expect(mode).toHaveBeenCalledTimes(1);
		expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("idle");
		expect(confirmDisabled()).toBe(true);
		expect(screen.queryByTestId("hotspot-confirm-radio-changed")).toBeNull();

		await answerQuestion();
		expect(mode).toHaveBeenCalledTimes(2);
	});

	it("keeps the Wi-Fi row free of errors before and after cancelling first consent", async () => {
		label("hotspot", "0", "1");
		mode.mockResolvedValueOnce(unobserved);
		const other = { ...row("hotspot", "radio-B"), ifname: "wlan1" };
		const view = section([
			["0", row("hotspot")],
			["1", other],
		]);
		wire.message("wifi", {
			adapter_mode: {
				device: "1",
				incarnation: "radio-B",
				error: "activation-failed",
			},
		});
		await open();
		await choose("hybrid");
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();

		await view.push([
			["0", row("station")],
			["1", other],
		]);
		await ready();
		expect(shown()).toBe("hotspot");
		expect(
			screen.getByTestId<HTMLInputElement>("hotspot-confirm-name").value,
		).toBe("radio-A-stored");
		expect(
			screen.getByTestId<HTMLInputElement>("hotspot-confirm-password").value,
		).toBe("stored-password");
		expect(confirmDisabled()).toBe(true);
		expect(screen.queryByTestId("hotspot-confirm-radio-changed")).toBeNull();
		expect(screen.getByTestId("wifi-mode-error-1").dataset.error).toBe(
			"activation-failed",
		);
		const beforeCancel = screen.queryByTestId("wifi-mode-error-0");

		await fireEvent.click(screen.getByTestId("hotspot-confirm-cancel"));
		expect(asked()).toBeNull();
		expect(mode).toHaveBeenCalledExactlyOnceWith({
			device: "0",
			mode: "hybrid",
			incarnation: "radio-A",
		});
		expect(prepare).toHaveBeenCalledExactlyOnceWith({
			device: "0",
			incarnation: "radio-A",
		});
		expect(screen.getByTestId("wifi-mode-error-1").dataset.error).toBe(
			"activation-failed",
		);
		expect(screen.queryByTestId("wifi-mode-error-0")).toBeNull();
		expect(beforeCancel).toBeNull();
	});

	for (const [outcome, terminal] of [
		["confirmed", { success: true }],
		["failed", { error: "activation-failed" }],
	] as const)
		it(`keeps a ${outcome} outcome that landed before the row said Station`, async () => {
			label("hotspot");
			mode.mockResolvedValueOnce(unobserved);
			const view = section([["0", row("hotspot")]]);
			await open();
			await choose("hybrid");
			await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
			await tick();
			wire.message("wifi", {
				adapter_mode: { device: "0", incarnation: "radio-A", ...terminal },
			});
			await tick();
			const key = wifiModeOpKey("0", "radio-A");
			const reason = getOperationReason(key);

			await view.push([["0", row("station")]]);
			await tick();
			await tick();
			expect(getOperationPhase(key)).toBe(outcome);
			expect(getOperationReason(key)).toBe(reason);
			expect(asked()).toBeNull();
			expect(mode).toHaveBeenCalledTimes(1);
		});

	it("keeps a same-radio success delivered after the consent veto", async () => {
		const withWifiEntryRetry = wifiEntryRequest.withWifiEntryRetry;
		using retry = vi.spyOn(wifiEntryRequest, "withWifiEntryRetry");
		retry.mockImplementation(async (...args) => {
			const result = await withWifiEntryRetry(...args);
			// Deliver success after the real retry decision but before mode settlement.
			wire.message("wifi", {
				adapter_mode: {
					device: "0",
					incarnation: "radio-A",
					mode: "hybrid",
					success: true,
				},
			});
			return result;
		});
		using command = vi.spyOn(
			await import("$lib/rpc/async-operation.svelte"),
			"osCommand",
		);
		label("hotspot");
		mode.mockResolvedValueOnce(unobserved);
		const view = section([["0", row("hotspot")]]);
		await open();
		await choose("hybrid");
		await view.push([["0", row("station")]]);

		const settlement = command.mock.results[0];
		if (settlement?.type !== "return")
			throw new Error("Mode command did not start");
		await settlement.value;
		await tick();
		expect(mode).toHaveBeenCalledExactlyOnceWith({
			device: "0",
			mode: "hybrid",
			incarnation: "radio-A",
		});
		expect(asked()).toBeNull();
		expect(prepare).not.toHaveBeenCalled();
		expect(screen.queryByTestId("wifi-mode-error-0")).toBeNull();
		expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("confirmed");
	});

	it("still resends once for a radio that kept its access point", async () => {
		label("hotspot");
		mode.mockResolvedValueOnce(unobserved);
		const view = section([["0", row("hotspot")]]);
		await open();
		await choose("hybrid");
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();

		await view.push([["0", row("hotspot")]]);
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(2));
		expect(asked()).toBeNull();
	});

	it("resends an answered change once without asking again", async () => {
		label("hotspot");
		mode.mockResolvedValueOnce(unobserved);
		const view = section([["0", row("station")]]);
		await open();
		await choose("hybrid");
		await answerQuestion();
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();

		await view.push([["0", row("station")]]);
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(2));
		expect(asked()).toBeNull();
	});

	it("shows the reload notice after an answered mode retry is refused", async () => {
		label("hotspot");
		mode.mockResolvedValueOnce(unobserved).mockResolvedValueOnce(unobserved);
		const view = section([["0", row("station")]]);
		await open();
		await choose("hybrid");
		await answerQuestion();
		await waitFor(() => expect(mode).toHaveBeenCalledTimes(1));
		await tick();

		await view.push([["0", row("station")]]);
		await ready();
		expect(mode).toHaveBeenCalledTimes(2);
		expect(confirmDisabled()).toBe(true);
		expect(screen.getByTestId("hotspot-confirm-radio-changed")).toBeTruthy();
		expect(getOperationPhase(wifiModeOpKey("0", "radio-A"))).toBe("failed");
		expect(screen.getByTestId("wifi-mode-error-0").dataset.error).toBe(
			"radio-changed",
		);
	});

	it("keeps an open question when the access point is read late, and sends nothing", async () => {
		label("hotspot");
		const view = section([["0", row("station")]]);
		await open();
		await choose("hybrid");
		await ready();

		await view.push([["0", row("hotspot")]]);
		await ready();
		expect(confirmDisabled()).toBe(true);
		expect(mode).not.toHaveBeenCalled();
	});
});

describe("the question belongs to one radio and one attempt", () => {
	it("starts nothing after its row disappears", async () => {
		label("hotspot");
		const view = section([["0", row("station")]]);
		await open();
		await choose("hybrid");
		await ready();

		await view.push([]);
		expect(asked()).toBeNull();
		await view.push([["0", row("station", "radio-B")]]);
		expect(asked()).toBeNull();
		expect(mode).not.toHaveBeenCalled();
	});

	it("asks for the client radio and not for the working hotspot beside it", async () => {
		label("hotspot", "0", "1");
		section([
			["0", row("station")],
			["1", { ...row("hotspot", "radio-1"), ifname: "wlan1" }],
		]);
		await open("0");
		await choose("hybrid", "0");
		await ready();
		expect(mode).not.toHaveBeenCalled();

		await open("1");
		await choose("hybrid", "1");
		expect(mode).toHaveBeenCalledTimes(1);
		expect(mode).toHaveBeenCalledWith({
			device: "1",
			mode: "hybrid",
			incarnation: "radio-1",
		});
	});

	it("asks again for a replaced adapter and drops the old acknowledgement", async () => {
		label("hotspot");
		const view = section([["0", row("station")]]);
		await open();
		await choose("hybrid");
		await acknowledge();
		expect(confirmDisabled()).toBe(false);

		await view.push([["0", row("station", "radio-B")]]);
		await ready();
		expect(confirmDisabled()).toBe(true);
		await answerQuestion();
		expect(mode).toHaveBeenCalledTimes(1);
		expect(mode).toHaveBeenCalledWith({
			device: "0",
			mode: "hybrid",
			incarnation: "radio-B",
		});
	});

	it("starts nothing while the stored details cannot be read", async () => {
		label("hotspot");
		prepare.mockRejectedValue(new Error("offline"));
		section([["0", row("station")]]);
		await open();
		await choose("hybrid");
		await waitFor(() => expect(asked()?.dataset.phase).toBe("load-failed"));
		expect(confirmDisabled()).toBe(true);
		expect(mode).not.toHaveBeenCalled();
	});

	it("drops an acknowledgement given before the link went down", async () => {
		label("hotspot");
		section([["0", row("station")]]);
		await open();
		await choose("hybrid");
		await acknowledge();

		noteLinkState("disconnected");
		await tick();
		await ready();
		expect(confirmDisabled()).toBe(true);
		expect(mode).not.toHaveBeenCalled();
	});

	it("sends once for a double press of the rung and of the confirm", async () => {
		label("hotspot");
		section([["0", row("station")]]);
		await open();
		const option = rung("hybrid");
		option.click();
		option.click();
		await tick();
		await acknowledge();
		const activate = screen.getByTestId("hotspot-confirm-activate");
		activate.click();
		activate.click();
		await tick();
		expect(mode).toHaveBeenCalledTimes(1);
	});
});
