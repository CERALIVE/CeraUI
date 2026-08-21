// @vitest-environment jsdom
/**
 * AN IN-PROGRESS EDIT SURVIVES AN INCOMING OBSERVATION.
 *
 * `formData` is a one-shot snapshot seeded on the OPEN EDGE, deliberately not
 * live-synced from the `modem` prop — and that decision is load-bearing rather
 * than incidental. The `modems` feed is a 5-second broadcast plus a targeted
 * re-broadcast after every scan, `configure`, GPS read, band read and USB
 * transition, so a live-synced form would discard the operator's half-typed APN
 * several times a minute, at a moment they cannot predict and with no warning.
 *
 * Nothing pinned it. This suite does, and it drives the edit the way an operator
 * makes it (typing into the rendered input) rather than by poking state, because
 * the seam that could break it is between the DOM and the prop.
 *
 * The mirror property is asserted too: a re-OPEN is precisely when the snapshot
 * is SUPPOSED to be replaced, so a test that only proves "the draft never
 * changes" would pass on a dialog that had stopped reading the device at all.
 */

import { m } from "@ceraui/i18n/svelte";
import type { Modem } from "@ceraui/rpc/schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
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
	publishModems,
	resetModemsFeed,
} from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const getFccUnlock = vi.hoisted(() => vi.fn());
const getGps = vi.hoisted(() => vi.fn());
const getBands = vi.hoisted(() => vi.fn());
const getUsbModeOptions = vi.hoisted(() => vi.fn());
const configure = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			getFccUnlock,
			getGps,
			getBands,
			getUsbModeOptions,
			configure,
			setFccUnlock: vi.fn(),
			setGps: vi.fn(),
			setBands: vi.fn(),
			setUsbMode: vi.fn(),
			setFiveGPreference: vi.fn(),
			scan: vi.fn(),
			getSms: vi.fn(async () => ({ success: true, messages: [] })),
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

function modem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		network_type: { supported: ["4g"], active: "4g" },
		status: {
			connection: "connected",
			network_type: "4g",
			signal: 72,
			roaming: false,
		},
		stable_key: "platform-xhci-hcd.0-usb-1:2",
		usb_mode: "rndis",
		config: {
			autoconfig: false,
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
		...overrides,
	} as unknown as Modem;
}

/** The same device, one broadcast later, with only its RADIO having moved. */
function observed(signal: number): Modem {
	return modem({
		status: {
			connection: "connected",
			network_type: "4g",
			signal,
			roaming: false,
		},
	} as Partial<Modem>);
}

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

beforeEach(() => {
	resetModemsFeed();
	getFccUnlock.mockResolvedValue({ success: false });
	getGps.mockResolvedValue({ success: false });
	getBands.mockResolvedValue({ success: false, error: "unsupported" });
	getUsbModeOptions.mockResolvedValue({ certified: [] });
	configure.mockResolvedValue({ success: true });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const apnInput = () => document.getElementById("modem-apn") as HTMLInputElement;
const usernameInput = () =>
	screen.getByLabelText(m["network.modem.username"]()) as HTMLInputElement;

async function mountAndType(text: string) {
	const subject = modem();
	publishModems({ "0": subject });
	const view = render(ModemConfigDialog, {
		props: { open: true, modem: subject, deviceId: "0" },
	});
	const input = apnInput();
	await fireEvent.input(input, { target: { value: text } });
	expect(apnInput().value).toBe(text);
	return view;
}

describe("an incoming observation never clobbers an in-progress edit", () => {
	it("keeps a half-typed APN through a signal update on the same modem", async () => {
		const { rerender } = await mountAndType("m2m.oper");

		await rerender({ modem: observed(41) });

		expect(apnInput().value).toBe("m2m.oper");
	});

	it("keeps it through a BURST of observations, the way a live feed arrives", async () => {
		const { rerender } = await mountAndType("staging.apn");

		for (const signal of [70, 64, 58, 51, 47, 44]) {
			await rerender({ modem: observed(signal) });
			publishModems({ "0": observed(signal) });
		}

		expect(apnInput().value).toBe("staging.apn");
	});

	// The nastiest shape: the device re-states the value the operator is in the
	// middle of REPLACING. A live-synced form snaps the field back mid-word.
	it("keeps it when the broadcast re-states the ORIGINAL value", async () => {
		const { rerender } = await mountAndType("newapn");

		await rerender({ modem: modem() });

		expect(apnInput().value).toBe("newapn");
	});

	it("keeps the credential fields too, not just the APN", async () => {
		const { rerender } = await mountAndType("corp.apn");
		await fireEvent.input(usernameInput(), { target: { value: "field-eng" } });

		await rerender({ modem: observed(33) });

		expect(apnInput().value).toBe("corp.apn");
		expect(usernameInput().value).toBe("field-eng");
	});
});

describe("…and the snapshot IS re-seeded on the open edge", () => {
	// Without this the suite above would pass on a dialog that had stopped
	// reading the device altogether, which is the opposite defect.
	it("a close/reopen adopts the device's own value again", async () => {
		const { rerender } = await mountAndType("discard.me");

		await rerender({ open: false, modem: modem() });
		await rerender({ open: true, modem: modem() });

		await vi.waitFor(() => expect(apnInput().value).toBe("internet"));
	});
});
