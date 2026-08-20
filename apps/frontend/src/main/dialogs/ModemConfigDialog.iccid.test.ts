// @vitest-environment jsdom
/**
 * The SIM's ICCID — RENDERED PLAINLY, and copyable.
 *
 * It is the deliberate opposite of the own-number field beside it, and that
 * contrast is what these tests pin. An ICCID is printed on the physical card and
 * is the value a carrier asks for over the phone to activate a line, so the
 * operator opened this dialog to READ it: masking it behind a reveal would
 * obstruct the only reason the row exists.
 *
 * Three properties are load-bearing:
 *
 *   · the digits are in the DOM immediately — no reveal, no mask, no toggle;
 *   · a modem that reported none renders NOTHING, never a dash or "Unknown";
 *   · the copy control actually writes the value, because a 19-digit string
 *     read off a screen into a phone call is what this affordance replaces.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetModemsFeed } from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const usbModeOptions = vi.hoisted(() => vi.fn());
const copyToClipboard = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			setUsbMode: vi.fn(),
			getUsbModeOptions: usbModeOptions,
			configure: vi.fn(),
			scan: vi.fn(),
		},
	},
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
	toast: { error: toastError, success: toastSuccess },
}));

vi.mock("$lib/helpers/clipboard", () => ({ copyToClipboard }));

/**
 * The bench Quectel RM530N-GL's REAL ICCID, read live off `ceralive2`. Unlike
 * the own-number fixture beside it this is NOT redacted — the value is printed
 * on the card and is meant to be read aloud.
 */
const BOARD_ICCID = "8957123102400060892";

function modemWith(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan3",
		name: "Quectel RM530N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 81,
			roaming: false,
		},
		...overrides,
	} as Modem;
}

function mount(modem: Modem, deviceId = "3") {
	return render(ModemConfigDialog, { props: { open: true, modem, deviceId } });
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
	usbModeOptions.mockReset();
	usbModeOptions.mockResolvedValue({ certified: [] });
	copyToClipboard.mockReset();
	copyToClipboard.mockResolvedValue(true);
	toastSuccess.mockReset();
	toastError.mockReset();
	resetModemsFeed();
});

describe("rendered plainly", () => {
	it("shows the digits immediately, with no reveal step", async () => {
		mount(modemWith({ iccid: BOARD_ICCID }));

		const value = await screen.findByTestId("modem-iccid");

		expect(value.textContent?.trim()).toBe(BOARD_ICCID);
		expect(document.body.textContent ?? "").toContain(BOARD_ICCID);
	});

	it("offers NO reveal toggle — that is the own-number field's contract, not this one", async () => {
		mount(modemWith({ iccid: BOARD_ICCID, own_numbers: ["+573115422359"] }));

		await screen.findByTestId("modem-iccid");

		// The own-number toggle must still be there: this asserts the two fields
		// were not accidentally unified, in either direction.
		expect(screen.queryByTestId("modem-own-number-toggle")).toBeTruthy();
		expect(screen.queryByTestId("modem-iccid-toggle")).toBeNull();
	});

	it("opens the detail card on its own, with no other detail present", async () => {
		mount(modemWith({ iccid: BOARD_ICCID }));

		expect(await screen.findByTestId("modem-detail-card")).toBeTruthy();
		expect(screen.getByTestId("modem-iccid").textContent?.trim()).toBe(
			BOARD_ICCID,
		);
	});
});

describe("absence renders as absence", () => {
	it("renders no row at all for a modem that reported none", async () => {
		mount(modemWith({ firmware_revision: "RM530NGLAAR05A01M4G" }));

		await screen.findByTestId("modem-firmware");

		expect(screen.queryByTestId("modem-iccid")).toBeNull();
		expect(screen.queryByTestId("modem-iccid-copy")).toBeNull();
	});

	it("renders no dash or placeholder for a blank value", async () => {
		mount(modemWith({ iccid: "   " } as Partial<Modem>));

		expect(screen.queryByTestId("modem-iccid")).toBeNull();
		expect(document.body.textContent ?? "").not.toContain("—");
	});
});

describe("the copy affordance", () => {
	it("copies the ICCID and confirms it", async () => {
		mount(modemWith({ iccid: BOARD_ICCID }));

		await fireEvent.click(await screen.findByTestId("modem-iccid-copy"));

		expect(copyToClipboard).toHaveBeenCalledWith(BOARD_ICCID);
		expect(toastSuccess).toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("reports a refused clipboard rather than claiming success", async () => {
		copyToClipboard.mockResolvedValue(false);
		mount(modemWith({ iccid: BOARD_ICCID }));

		await fireEvent.click(await screen.findByTestId("modem-iccid-copy"));

		expect(toastError).toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("carries an accessible name, so the icon-only button is not bare", async () => {
		mount(modemWith({ iccid: BOARD_ICCID }));

		const button = await screen.findByTestId("modem-iccid-copy");

		expect(button.getAttribute("aria-label")?.trim()).toBeTruthy();
	});
});
