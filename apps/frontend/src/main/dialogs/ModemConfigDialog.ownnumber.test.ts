// @vitest-environment jsdom
/**
 * The SIM's own number — HIDDEN BY DEFAULT, revealed only on request.
 *
 * Three properties are load-bearing and each is asserted against the rendered
 * DOM rather than against the pure helper, because the defect this guards is a
 * component that renders the value anyway:
 *
 *   · the number is NEVER in the DOM before the operator reveals it — a
 *     `hidden` attribute or a CSS mask would still put it in a screen share,
 *     a screenshot, and the accessibility tree;
 *   · a modem whose carrier published no number renders NOTHING — no label, no
 *     dash, no "Unknown". Most SIMs carry none, so a placeholder would read as
 *     a failed read on the majority of devices;
 *   · the reveal is per VIEWING: it re-hides on close, and on a switch to a
 *     different modem, so one operator's reveal cannot outlive the moment.
 */

import type { Modem } from "@ceraui/rpc/schemas";
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

import { resetModemsFeed } from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const usbModeOptions = vi.hoisted(() => vi.fn());

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
	toast: { error: vi.fn(), success: vi.fn() },
}));

/** The bench Quectel RM530N-GL's own SIM, as `mmcli -m 3` reported it live. */
const BOARD_OWN_NUMBER = "+573115422359";
const SECOND_OWN_NUMBER = "+573001112233";

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
	resetModemsFeed();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("hidden by default", () => {
	it("renders the field but NOT the number", async () => {
		mount(modemWith({ own_numbers: [BOARD_OWN_NUMBER] }));

		expect(await screen.findByTestId("modem-own-number")).toBeTruthy();
		const value = screen.getByTestId("modem-own-number-value-0");
		expect(value.textContent?.trim()).not.toBe(BOARD_OWN_NUMBER);
		expect(value.dataset.revealed).toBe("false");
		expect(document.body.textContent ?? "").not.toContain(BOARD_OWN_NUMBER);
	});

	it("masks with a FIXED width, so the digit count does not leak", async () => {
		const shortView = mount(modemWith({ own_numbers: ["+15550100"] }));
		const short = (
			await screen.findByTestId("modem-own-number-value-0")
		).textContent?.trim();
		shortView.unmount();

		mount(modemWith({ own_numbers: ["+573115422359999"] }), "4");
		const long = (
			await screen.findByTestId("modem-own-number-value-0")
		).textContent?.trim();

		expect(short).toBe(long);
		expect(short).not.toContain("5");
	});

	it("offers a reveal control that says what it will do", async () => {
		mount(modemWith({ own_numbers: [BOARD_OWN_NUMBER] }));

		const toggle = await screen.findByTestId("modem-own-number-toggle");
		expect(toggle.getAttribute("aria-label")).toMatch(/show/i);
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
	});
});

describe("the reveal", () => {
	it("shows the number, and hides it again", async () => {
		mount(modemWith({ own_numbers: [BOARD_OWN_NUMBER] }));
		const toggle = await screen.findByTestId("modem-own-number-toggle");

		await fireEvent.click(toggle);

		const value = screen.getByTestId("modem-own-number-value-0");
		expect(value.textContent?.trim()).toBe(BOARD_OWN_NUMBER);
		expect(value.dataset.revealed).toBe("true");
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		expect(toggle.getAttribute("aria-label")).toMatch(/hide/i);

		await fireEvent.click(toggle);

		expect(
			screen.getByTestId("modem-own-number-value-0").textContent?.trim(),
		).not.toBe(BOARD_OWN_NUMBER);
		expect(document.body.textContent ?? "").not.toContain(BOARD_OWN_NUMBER);
	});

	it("reveals EVERY number a multi-number SIM published, in order", async () => {
		mount(modemWith({ own_numbers: [BOARD_OWN_NUMBER, SECOND_OWN_NUMBER] }));

		await fireEvent.click(await screen.findByTestId("modem-own-number-toggle"));

		expect(
			screen.getByTestId("modem-own-number-value-0").textContent?.trim(),
		).toBe(BOARD_OWN_NUMBER);
		expect(
			screen.getByTestId("modem-own-number-value-1").textContent?.trim(),
		).toBe(SECOND_OWN_NUMBER);
	});

	it("re-hides when the dialog is pointed at a DIFFERENT modem", async () => {
		const view = mount(modemWith({ own_numbers: [BOARD_OWN_NUMBER] }), "3");
		await fireEvent.click(await screen.findByTestId("modem-own-number-toggle"));
		expect(
			screen.getByTestId("modem-own-number-value-0").textContent?.trim(),
		).toBe(BOARD_OWN_NUMBER);

		await view.rerender({
			open: true,
			deviceId: "4",
			modem: modemWith({
				ifname: "wwan4",
				name: "SIMCom SIM7600G-H",
				own_numbers: [SECOND_OWN_NUMBER],
			}),
		});

		expect(document.body.textContent ?? "").not.toContain(SECOND_OWN_NUMBER);
		expect(
			screen.getByTestId("modem-own-number-value-0").dataset.revealed,
		).toBe("false");
	});

	it("re-hides when the dialog is closed and reopened", async () => {
		const view = mount(modemWith({ own_numbers: [BOARD_OWN_NUMBER] }));
		await fireEvent.click(await screen.findByTestId("modem-own-number-toggle"));
		expect(document.body.textContent ?? "").toContain(BOARD_OWN_NUMBER);

		await view.rerender({
			open: false,
			deviceId: "3",
			modem: modemWith({ own_numbers: [BOARD_OWN_NUMBER] }),
		});
		await view.rerender({
			open: true,
			deviceId: "3",
			modem: modemWith({ own_numbers: [BOARD_OWN_NUMBER] }),
		});

		expect(document.body.textContent ?? "").not.toContain(BOARD_OWN_NUMBER);
	});
});

describe("honest absence", () => {
	it("a modem that published no number renders NOTHING — not a placeholder", async () => {
		mount(modemWith({ firmware_revision: "RM530NGLAAR05A01M4G" }));

		expect(await screen.findByTestId("modem-detail-card")).toBeTruthy();
		expect(screen.queryByTestId("modem-own-number")).toBeNull();
		expect(screen.queryByTestId("modem-own-number-toggle")).toBeNull();
		const text = document.body.textContent ?? "";
		expect(text).not.toMatch(/SIM phone number/i);
		expect(text).not.toMatch(/unknown number|N\/A/i);
	});

	it("an EMPTY list is absence too, never an empty row", async () => {
		mount(
			modemWith({
				own_numbers: [],
				firmware_revision: "RM530NGLAAR05A01M4G",
			} as Partial<Modem>),
		);

		expect(await screen.findByTestId("modem-detail-card")).toBeTruthy();
		expect(screen.queryByTestId("modem-own-number")).toBeNull();
	});

	it("a number ALONE is enough to open the detail card", async () => {
		mount(modemWith({ own_numbers: [BOARD_OWN_NUMBER] }));

		expect(await screen.findByTestId("modem-detail-card")).toBeTruthy();
		expect(screen.queryByTestId("modem-firmware")).toBeNull();
		expect(screen.queryByTestId("modem-esim")).toBeNull();
	});
});
