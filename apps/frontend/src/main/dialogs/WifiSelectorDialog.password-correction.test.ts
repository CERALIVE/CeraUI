// @vitest-environment jsdom
/**
 * WifiSelectorDialog — a retained profile's password can be corrected in place.
 *
 * A failed join keeps its profile, so the network turns Saved and its Connect
 * retries the mistyped secret. The row offers its own password entry, which
 * goes out through `connectNew` with the SSID; the device rewrites the secret of
 * the profile saved under that SSID and brings up the SAME uuid.
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
	failOperation,
	getOperationPhase,
} from "$lib/rpc/async-operation.svelte";

import {
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
const SSID = "HomeWiFi";
const OPEN_SSID = "Guest";
const SAE_ONLY_SSID = "Studio";
const RETAINED_UUID = "uuid-retained";
const WRONG = "wrong-pass";
const CORRECTED = "right-pass-2";

function radio({
	conn = "",
	saved = {} as Record<string, string>,
	ssids = [SSID],
	activeSsid = undefined as string | undefined,
} = {}) {
	return {
		ifname: "wlan0",
		conn,
		hw: "aa:bb:cc:dd:ee:01",
		saved,
		available: ssids.map((ssid) => ({
			active: ssid === activeSsid,
			ssid,
			signal: 70,
			security:
				ssid === OPEN_SSID ? "" : ssid === SAE_ONLY_SSID ? "WPA3" : "WPA2",
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

const passwordInput = () =>
	screen.queryByLabelText("Please enter the network password");

async function submitPassword(value: string): Promise<void> {
	const input = passwordInput();
	if (!input) throw new Error("password form is not shown");
	await fireEvent.input(input, { target: { value } });
	await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
	await settle();
}

async function failFirstJoin(): Promise<void> {
	publishWifi({ "0": radio() });
	render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
	await settle();
	await fireEvent.click(
		screen.getByRole("button", { name: `Connect ${SSID}` }),
	);
	await settle();
	await submitPassword(WRONG);
	expect(connectNew).toHaveBeenCalledTimes(1);
	expect(connectNew).toHaveBeenLastCalledWith({
		device: "0",
		ssid: SSID,
		password: WRONG,
		security: "WPA2",
	});
	// The device's typed refusal, as the subscriptions `wifi { new }` route delivers it.
	failOperation(CONNECT_KEY, "auth");
	await settle();
	expect(screen.getByRole("alert").dataset.reason).toBe("auth");
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

describe("WifiSelectorDialog — correcting a password after a failed join", () => {
	it("without a retained profile, the row still opens the password form", async () => {
		await failFirstJoin();

		await fireEvent.click(
			screen.getByRole("button", { name: `Connect ${SSID}` }),
		);
		await settle();
		await submitPassword(CORRECTED);

		expect(connect).not.toHaveBeenCalled();
		expect(connectNew).toHaveBeenLastCalledWith({
			device: "0",
			ssid: SSID,
			password: CORRECTED,
			security: "WPA2",
		});
	});

	it("a retained profile takes a corrected password and reconnects the same uuid", async () => {
		await failFirstJoin();

		publishWifi({ "0": radio({ saved: { [SSID]: RETAINED_UUID } }) });
		await settle();
		expect(passwordInput()).toBeNull();

		const change = screen.getByRole("button", {
			name: `Change password ${SSID}`,
		});
		expect(change.getAttribute("aria-expanded")).toBe("false");
		await fireEvent.click(change);
		await settle();
		expect(change.getAttribute("aria-expanded")).toBe("true");

		await submitPassword(CORRECTED);

		// Not the saved-secret retry: the corrected secret goes out with the SSID,
		// which the device resolves to the profile saved under it.
		expect(connect).not.toHaveBeenCalled();
		expect(connectNew).toHaveBeenCalledTimes(2);
		expect(connectNew).toHaveBeenLastCalledWith({
			device: "0",
			ssid: SSID,
			password: CORRECTED,
			security: "WPA2",
		});
		expect(getOperationPhase(CONNECT_KEY)).toBe("pending");
		expect(screen.queryByText("Connecting…")).not.toBeNull();

		publishWifi({
			"0": radio({
				conn: RETAINED_UUID,
				saved: { [SSID]: RETAINED_UUID },
				activeSsid: SSID,
			}),
		});
		await settle();
		expect(getOperationPhase(CONNECT_KEY)).toBe("confirmed");
	});

	// An SAE-only join always adds a new profile on the device, so a correction
	// there would leave a duplicate beside the retained one.
	it("offers no password change on an open, an SAE-only or an active saved network", async () => {
		publishWifi({
			"0": radio({
				conn: "uuid-home",
				saved: {
					[SSID]: "uuid-home",
					[OPEN_SSID]: "uuid-guest",
					[SAE_ONLY_SSID]: "uuid-studio",
				},
				ssids: [SSID, OPEN_SSID, SAE_ONLY_SSID],
				activeSsid: SSID,
			}),
		});
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();

		expect(
			screen.getByRole("button", { name: `Forget ${OPEN_SSID}` }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: `Connect ${SAE_ONLY_SSID}` }),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /^Change password / }),
		).toBeNull();
	});
});
