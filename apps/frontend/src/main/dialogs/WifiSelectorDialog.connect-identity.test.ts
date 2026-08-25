// @vitest-environment jsdom
/**
 * WifiSelectorDialog — a connect is confirmed by the profile the operator
 * DISPATCHED, never by an SSID being active (F-06).
 *
 * NetworkManager holds one saved profile per SSID on the wire, but several on
 * the device — a re-created profile, an auto-connect sibling, a hidden twin.
 * The retired secondary confirm asked only "is a network with the target SSID
 * active now?", which any of them satisfied. So an activation the operator never
 * asked for resolved their pending connect, closed the dialog, and reported
 * success for a connection they did not make.
 *
 * These are RENDERED tests against the real dialog and a rune-backed `wifi`
 * feed: a plain `vi.fn()` feed is not reactive, so the confirm `$effect` would
 * never re-run and the suite would prove the opposite of what it claims.
 */

import { fireEvent, render, screen } from "@testing-library/svelte";
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
	clearOperation,
	getOperationPhase,
} from "$lib/rpc/async-operation.svelte";

import {
	getWifiFeed,
	publishWifi,
	resetWifiFeed,
} from "../../tests/helpers/wifi-feed.svelte";
import WifiSelectorDialog from "./WifiSelectorDialog.svelte";

const scan = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
const connectNew = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		wifi: {
			scan,
			connect,
			connectNew,
			disconnect: vi.fn(),
			forget: vi.fn(),
		},
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("../../tests/helpers/wifi-feed.svelte");
	return { getWifi: () => feed.getWifiFeed() };
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const CONNECT_KEY = "wifi:0";
const SCAN_KEY = "wifi-scan:0";

/** The SSID two saved profiles share. */
const SHARED_SSID = "CafeWiFi";
/** The profile the operator taps. */
const CHOSEN_UUID = "uuid-chosen";
/** Its sibling, which NetworkManager may bring up on its own. */
const SIBLING_UUID = "uuid-sibling";

/**
 * The one SSID kept OPEN, so tapping Connect on it dispatches `connectNew`
 * straight away instead of revealing the inline password form.
 */
const OPEN_SSID = "Guest";

interface RadioOptions {
	/** The interface's ACTIVE connection uuid (`""` = nothing connected). */
	conn?: string;
	/** SSID → saved profile uuid, as the device records it. */
	saved?: Record<string, string>;
	/** SSIDs currently in the air; `activeSsid` flags the connected one. */
	ssids?: string[];
	activeSsid?: string;
}

function radio({
	conn = "",
	saved = { [SHARED_SSID]: CHOSEN_UUID },
	ssids = [SHARED_SSID],
	activeSsid,
}: RadioOptions = {}) {
	return {
		ifname: "wlan0",
		conn,
		hw: "aa:bb:cc:dd:ee:01",
		saved,
		available: ssids.map((ssid) => ({
			active: ssid === activeSsid,
			ssid,
			signal: 70,
			security: ssid === OPEN_SSID ? "" : "WPA2",
			freq: 2437,
		})),
		scanGeneration: 1,
		scanAt: 1_700_000_000_000,
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
		vi.advanceTimersByTime(0);
	}
}

/**
 * The ROW's connect spinner. Its copy (`network.os.connecting`, "Connecting…")
 * is deliberately distinct from the scan bar's `wifiSelector.dialog.connecting`
 * ("Connecting..."), so this cannot resolve the wrong element.
 */
function connectSpinnerShown(): boolean {
	return screen.queryByText("Connecting…") !== null;
}

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
	vi.useFakeTimers();
	scan.mockReset();
	scan.mockResolvedValue({ success: true });
	connect.mockReset();
	connect.mockResolvedValue({ success: true });
	connectNew.mockReset();
	connectNew.mockResolvedValue({ success: true });
	resetWifiFeed();
	clearOperation(CONNECT_KEY);
	clearOperation(SCAN_KEY);
});

afterEach(() => {
	clearOperation(CONNECT_KEY);
	clearOperation(SCAN_KEY);
	vi.useRealTimers();
});

describe("WifiSelectorDialog — identity-keyed connect confirmation", () => {
	it("a SIBLING profile sharing the SSID does NOT confirm the operator's connect", async () => {
		// Given: a saved network the operator is not currently on.
		publishWifi({ "0": radio() });
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();

		// When: they tap Connect on it.
		await fireEvent.click(
			screen.getByRole("button", { name: `Connect ${SHARED_SSID}` }),
		);
		await settle();
		expect(connect).toHaveBeenCalledWith({ uuid: CHOSEN_UUID });
		expect(getOperationPhase(CONNECT_KEY)).toBe("pending");

		// …and the device brings up a DIFFERENT profile carrying the SAME SSID.
		// `saved` keeps ONE uuid per SSID on the wire (`wifi-connections.ts`), so
		// the sibling is invisible to this surface EXCEPT through `conn` — which is
		// precisely why an SSID can never be the identity here.
		publishWifi({
			"0": radio({ conn: SIBLING_UUID, activeSsid: SHARED_SSID }),
		});
		await settle();

		// Then: nothing is claimed. Non-vacuity — the snapshot really does show the
		// target SSID active, which is exactly what the retired rule confirmed on.
		expect(getWifiFeed()["0"]?.conn).toBe(SIBLING_UUID);
		expect(
			getWifiFeed()["0"]?.available?.some(
				(n) => n.ssid === SHARED_SSID && n.active,
			),
		).toBe(true);
		expect(getOperationPhase(CONNECT_KEY)).toBe("pending");
		expect(connectSpinnerShown()).toBe(true);
	});

	it("…and confirms the moment the DISPATCHED profile is the active one", async () => {
		publishWifi({ "0": radio() });
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();

		await fireEvent.click(
			screen.getByRole("button", { name: `Connect ${SHARED_SSID}` }),
		);
		await settle();

		publishWifi({
			"0": radio({ conn: CHOSEN_UUID, activeSsid: SHARED_SSID }),
		});
		await settle();

		expect(getOperationPhase(CONNECT_KEY)).toBe("confirmed");
	});

	it("a fresh join waits for the profile the DEVICE minted for its SSID", async () => {
		// Given: an open network with no saved profile, while the radio sits on a
		// different connection.
		publishWifi({
			"0": radio({
				conn: "uuid-home",
				saved: { Home: "uuid-home" },
				ssids: ["Home", OPEN_SSID],
				activeSsid: "Home",
			}),
		});
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();

		// When: the operator joins it.
		await fireEvent.click(
			screen.getByRole("button", { name: `Connect ${OPEN_SSID}` }),
		);
		await settle();
		expect(connectNew).toHaveBeenCalledTimes(1);
		expect(getOperationPhase(CONNECT_KEY)).toBe("pending");

		// …and some OTHER connection comes up first.
		publishWifi({
			"0": radio({
				conn: "uuid-neighbour",
				saved: { Home: "uuid-home", Neighbour: "uuid-neighbour" },
				ssids: ["Home", OPEN_SSID, "Neighbour"],
				activeSsid: "Neighbour",
			}),
		});
		await settle();
		expect(getOperationPhase(CONNECT_KEY)).toBe("pending");

		// Then: only the device recording — and activating — a profile for OUR ssid
		// resolves it.
		publishWifi({
			"0": radio({
				conn: "uuid-guest",
				saved: { Home: "uuid-home", [OPEN_SSID]: "uuid-guest" },
				ssids: ["Home", OPEN_SSID],
				activeSsid: OPEN_SSID,
			}),
		});
		await settle();
		expect(getOperationPhase(CONNECT_KEY)).toBe("confirmed");
	});

	it("keeps the spinner on the dispatched row, not on its SSID sibling's row", async () => {
		publishWifi({ "0": radio({ ssids: [SHARED_SSID, "Other"] }) });
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();

		await fireEvent.click(
			screen.getByRole("button", { name: `Connect ${SHARED_SSID}` }),
		);
		await settle();

		// The other row keeps its own (now os-busy-disabled) Connect button rather
		// than borrowing the in-flight row's spinner.
		expect(connectSpinnerShown()).toBe(true);
		const other = screen.getByRole("button", {
			name: "Connect Other",
		}) as HTMLButtonElement;
		expect(other.disabled).toBe(true);
	});
});
