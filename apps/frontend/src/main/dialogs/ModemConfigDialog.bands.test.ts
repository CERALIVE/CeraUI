// @vitest-environment jsdom
/**
 * ModemConfigDialog — the band-lock control, rendered.
 *
 * Two properties carry this suite, and neither can be asserted anywhere but the
 * DOM:
 *
 *   1. THE CONTROL IS HIDDEN WITHOUT CERTIFICATION EVIDENCE, and a withheld
 *      offer renders NO control at all — not a disabled one, which would imply a
 *      capability being kept back rather than one nobody has proven. Absence has
 *      no syntax to grep for, so it is counted.
 *   2. IT IS IN THE PRIMARY SURFACE. The dialog's own docs put every other
 *      instrument card behind the "Advanced" disclosure; this one is out of it
 *      by explicit product decision, and the only honest way to state that is by
 *      ancestry in the rendered tree.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
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

const getBands = vi.hoisted(() => vi.fn());
const setBands = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			getBands,
			setBands,
			getUsbModeOptions: vi.fn(async () => ({ certified: [] })),
			setUsbMode: vi.fn(),
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

const KEY = "platform-xhci-hcd.0-usb-1:4";

function modem(): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 72,
			roaming: false,
		},
		stable_key: KEY,
	} as Modem;
}

function certified(current: string[] = ["any"]) {
	return {
		success: true,
		bands: {
			supported: ["eutran-1", "eutran-3", "eutran-7", "ngran-78"],
			current,
			offerable: ["eutran-3", "eutran-7"],
			unlocked: current.length === 1 && current[0] === "any",
		},
	};
}

function mount() {
	return render(ModemConfigDialog, {
		props: { open: true, modem: modem(), deviceId: "0" },
	});
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
	Element.prototype.scrollIntoView = vi.fn();
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as never;
});

beforeEach(() => {
	resetModemsFeed();
	publishModems({ 0: modem() });
	getBands.mockReset();
	setBands.mockReset();
});

afterEach(() => {
	resetModemsFeed();
});

describe("the control is HIDDEN without certification evidence", () => {
	it("an `uncertified` device gets NO band control — only the reason", async () => {
		getBands.mockResolvedValue({ success: false, error: "uncertified" });
		mount();

		await waitFor(() => {
			expect(screen.getByTestId("modem-bands-unavailable")).toBeTruthy();
		});
		expect(screen.queryByTestId("modem-bands-card")).toBeNull();
		expect(screen.queryByTestId("modem-bands-options")).toBeNull();
		// Not a disabled control either — there is nothing to re-enable.
		expect(screen.queryByRole("checkbox", { name: /eutran/i })).toBeNull();
	});

	it("a read that never answered asserts NOTHING at all", async () => {
		getBands.mockRejectedValue(new Error("socket closed"));
		mount();

		await waitFor(() => {
			expect(getBands).toHaveBeenCalled();
		});
		expect(screen.queryByTestId("modem-bands-card")).toBeNull();
		expect(screen.queryByTestId("modem-bands-unavailable")).toBeNull();
	});

	it("a certified device with an EMPTY offerable set renders no card", async () => {
		getBands.mockResolvedValue({
			success: true,
			bands: {
				supported: ["eutran-3"],
				current: ["any"],
				offerable: [],
				unlocked: true,
			},
		});
		mount();

		await waitFor(() => {
			expect(getBands).toHaveBeenCalled();
		});
		expect(screen.queryByTestId("modem-bands-card")).toBeNull();
	});
});

describe("a certified device", () => {
	it("renders the card in the PRIMARY surface, outside the Advanced disclosure", async () => {
		getBands.mockResolvedValue(certified());
		mount();

		const card = await screen.findByTestId("modem-bands-card");
		const advanced = screen.getByTestId("modem-advanced-body");
		expect(advanced.contains(card)).toBe(false);
	});

	it("offers `any` alongside the certified bands, and nothing else", async () => {
		getBands.mockResolvedValue(certified());
		mount();

		const options = await screen.findByTestId("modem-bands-options");
		const labels = [
			...options.querySelectorAll('[data-testid^="modem-band-option-"]'),
		].map((node) => node.getAttribute("data-testid"));
		expect(labels).toEqual([
			"modem-band-option-any",
			"modem-band-option-eutran-3",
			"modem-band-option-eutran-7",
		]);
		// A band the modem advertises but the catalog does not prove is NOT offered.
		expect(screen.queryByTestId("modem-band-option-ngran-78")).toBeNull();
	});

	it("offers NO Apply until the selection actually differs", async () => {
		getBands.mockResolvedValue(certified());
		mount();

		await screen.findByTestId("modem-bands-card");
		expect(
			screen.queryByRole("button", { name: /Apply band selection/i }),
		).toBeNull();

		await fireEvent.click(screen.getByTestId("modem-band-option-eutran-3"));
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Apply band selection/i }),
			).toBeTruthy();
		});
	});

	it("reports the DEVICE's outcome — an auto-restore is never a success", async () => {
		getBands.mockResolvedValue(certified());
		setBands.mockResolvedValue({
			success: false,
			status: "auto_restored",
			bands: ["any"],
		});
		mount();

		await screen.findByTestId("modem-bands-card");
		await fireEvent.click(screen.getByTestId("modem-band-option-eutran-3"));
		await fireEvent.click(
			screen.getByRole("button", { name: /Apply band selection/i }),
		);
		await fireEvent.click(
			await screen.findByRole("button", { name: /Change bands/i }),
		);

		const outcome = await screen.findByTestId("modem-bands-outcome");
		expect(outcome.textContent).toMatch(/could not register/i);
		expect(setBands).toHaveBeenCalledWith({
			device: "0",
			bands: ["eutran-3"],
			confirm: true,
		});
	});

	it("re-reads the modem after applying rather than trusting the reply", async () => {
		getBands.mockResolvedValue(certified());
		setBands.mockResolvedValue({
			success: true,
			status: "applied",
			bands: ["eutran-3"],
		});
		mount();

		await screen.findByTestId("modem-bands-card");
		const readsBefore = getBands.mock.calls.length;
		await fireEvent.click(screen.getByTestId("modem-band-option-eutran-3"));
		await fireEvent.click(
			screen.getByRole("button", { name: /Apply band selection/i }),
		);
		await fireEvent.click(
			await screen.findByRole("button", { name: /Change bands/i }),
		);

		await waitFor(() => {
			expect(getBands.mock.calls.length).toBeGreaterThan(readsBefore);
		});
	});
});
