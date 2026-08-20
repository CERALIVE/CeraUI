// @vitest-environment jsdom
/**
 * GPS AND FCC OUTCOMES ARE ANNOUNCED — `DESIGN.md` §8, asserted against the
 * rendered accessibility surface rather than against the handler that produces
 * it.
 *
 * These two toggles are the app's clearest instance of the failure §8 opens
 * with: they are PESSIMISTIC controls whose visible state is read back from the
 * device, so an operator using a screen reader who flipped one received exactly
 * nothing — the switch stayed where it was, no text appeared, and the difference
 * between "the receiver is on now" and "the modem refused" was carried by a
 * control position they could not see change. The failure path was marginally
 * better (a bare `<p>` with no role, which announces nothing either).
 *
 * FOUR PROPERTIES, and each maps to a numbered rule:
 *
 *   LR-1 — the regions exist before the first toggle, on both modules.
 *   LR-2 — success is polite; a refusal is assertive. Never the other way.
 *   LR-5 — a terminal outcome always arrives. Silence is not an ending.
 *   LR-4 — the sentence is catalog copy: no dotted key, no wire token, no
 *          `undefined` leaking through a template.
 */

import type { CapabilityModuleClaims, Modem } from "@ceraui/rpc/schemas";
import { CAPABILITY_MODULES } from "@ceraui/rpc/schemas";
import { cleanup, render, screen } from "@testing-library/svelte";
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
const setFccUnlock = vi.hoisted(() => vi.fn());
const getGps = vi.hoisted(() => vi.fn());
const setGps = vi.hoisted(() => vi.fn());
const getBands = vi.hoisted(() => vi.fn());
const getUsbModeOptions = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			getFccUnlock,
			setFccUnlock,
			getGps,
			setGps,
			getBands,
			getUsbModeOptions,
			setBands: vi.fn(),
			setUsbMode: vi.fn(),
			setFiveGPreference: vi.fn(),
			configure: vi.fn(),
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

function claims(
	overrides: Partial<CapabilityModuleClaims> = {},
): CapabilityModuleClaims {
	return Object.fromEntries(
		CAPABILITY_MODULES.map((module) => [
			module,
			overrides[module] ?? "unavailable",
		]),
	) as CapabilityModuleClaims;
}

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
		capability_modules: claims({
			gps: "capable",
			"fcc-auto-unlock": "capable",
		}),
		...overrides,
	} as Modem;
}

function mount(subject: Modem = modem()) {
	publishModems({ "0": subject });
	return render(ModemConfigDialog, {
		props: { open: true, modem: subject, deviceId: "0" },
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
			dispatchEvent: vi.fn(),
		}));
	}
});

beforeEach(() => {
	resetModemsFeed();
	getFccUnlock.mockResolvedValue({
		success: true,
		state: {
			key: "2c7c:0801",
			coverage: "present",
			enabled: false,
			model_wide: true,
			requires_reprobe: true,
		},
	});
	setFccUnlock.mockResolvedValue({
		success: true,
		state: {
			key: "2c7c:0801",
			coverage: "present",
			enabled: true,
			model_wide: true,
			requires_reprobe: true,
		},
	});
	getGps.mockResolvedValue({
		success: true,
		status: { gnssEnabled: false },
		state: { kind: "off" },
	});
	setGps.mockResolvedValue({
		success: true,
		status: { gnssEnabled: true },
		state: { kind: "acquiring" },
	});
	getBands.mockResolvedValue({ success: false, error: "unsupported" });
	getUsbModeOptions.mockResolvedValue({ certified: [] });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/**
 * Both modules ride the exact same contract, so one table drives both. Adding a
 * third gated mutation should extend this rather than fork a second suite.
 */
const MODULES = [
	{
		name: "GPS",
		module: "gps",
		toggle: "modem-gps-toggle",
		region: "modem-gps",
		set: setGps,
		refuse: () =>
			setGps.mockResolvedValue({ success: false, error: "unsupported" }),
		reject: () => setGps.mockRejectedValue(new Error("socket closed")),
	},
	{
		name: "FCC auto-unlock",
		module: "fcc-auto-unlock",
		toggle: "modem-fcc-unlock-toggle",
		region: "modem-fcc-unlock",
		set: setFccUnlock,
		refuse: () =>
			setFccUnlock.mockResolvedValue({ success: false, error: "not_covered" }),
		reject: () => setFccUnlock.mockRejectedValue(new Error("socket closed")),
	},
] as const;

describe.each(MODULES)(
	"$name outcomes",
	({ toggle, region, set, refuse, reject }) => {
		const polite = () => screen.getByTestId(`${region}-announce-polite`);
		const assertive = () => screen.getByTestId(`${region}-announce-assertive`);
		const band = () => screen.queryByTestId(`${region}-outcome`);

		async function flip(): Promise<void> {
			(await screen.findByTestId(toggle)).click();
			await vi.waitFor(() => expect(set).toHaveBeenCalled());
		}

		// LR-1. A region created when the answer arrives announces nothing at all.
		it("mounts both live regions before the operator can touch the control", async () => {
			mount();
			await screen.findByTestId(toggle);

			expect(polite().getAttribute("aria-live")).toBe("polite");
			expect(polite().getAttribute("role")).toBe("status");
			expect(assertive().getAttribute("aria-live")).toBe("assertive");
			expect(assertive().getAttribute("role")).toBe("alert");
			expect(polite().textContent).toBe("");
			expect(assertive().textContent).toBe("");
			expect(band()).toBeNull();
		});

		// LR-2 + LR-5. The success half is the one that did not exist at all before.
		it("announces a SUCCESS politely and leaves it on screen", async () => {
			mount();
			await flip();

			const applied = await screen.findByTestId(`${region}-outcome`);
			expect(applied.getAttribute("data-outcome")).toBe("applied");
			await vi.waitFor(() =>
				expect(polite().textContent?.trim().length).toBeGreaterThan(0),
			);
			expect(assertive().textContent).toBe("");
		});

		// LR-2's absolute clause, from the other side.
		it("announces a REFUSAL assertively, and never in the polite region", async () => {
			refuse();
			mount();
			await flip();

			const refused = await screen.findByTestId(`${region}-outcome`);
			expect(refused.getAttribute("data-outcome")).toBe("refused");
			await vi.waitFor(() =>
				expect(assertive().textContent?.trim().length).toBeGreaterThan(0),
			);
			expect(polite().textContent).toBe("");
		});

		// LR-5. A thrown call is the case that used to end in silence.
		it("a thrown call still reaches a terminal announced outcome", async () => {
			reject();
			mount();
			await flip();

			const refused = await screen.findByTestId(`${region}-outcome`);
			expect(refused.getAttribute("data-outcome")).toBe("refused");
			await vi.waitFor(() =>
				expect(assertive().textContent?.trim().length).toBeGreaterThan(0),
			);
		});

		// LR-4. The catalog is the only source of these sentences.
		it("announces catalog copy — no dotted key, no wire token, no `undefined`", async () => {
			refuse();
			mount();
			await flip();
			await screen.findByTestId(`${region}-outcome`);

			const announced = assertive().textContent ?? "";
			expect(announced).not.toMatch(/network\.modem\./);
			expect(announced).not.toContain("undefined");
			expect(announced).not.toMatch(/^[a-z_]+$/);
		});

		// The outcome is a RECORD, not a transient: an operator who looked away must
		// still find it. It clears only on the NEXT dispatch.
		it("persists after the mutation completes, and is replaced only by the next one", async () => {
			mount();
			await flip();
			const first = (await screen.findByTestId(`${region}-outcome`))
				.textContent;

			for (let tick = 0; tick < 3; tick += 1) {
				await Promise.resolve();
			}
			expect(screen.getByTestId(`${region}-outcome`).textContent).toBe(first);

			refuse();
			set.mockClear();
			screen.getByTestId(toggle).click();
			await vi.waitFor(() => expect(set).toHaveBeenCalled());
			await vi.waitFor(() =>
				expect(
					screen.getByTestId(`${region}-outcome`).getAttribute("data-outcome"),
				).toBe("refused"),
			);
		});
	},
);

describe("the two modules do not announce into each other's regions", () => {
	it("a GPS refusal leaves the FCC regions empty", async () => {
		setGps.mockResolvedValue({ success: false, error: "unsupported" });
		mount();

		(await screen.findByTestId("modem-gps-toggle")).click();
		await vi.waitFor(() => expect(setGps).toHaveBeenCalled());
		await screen.findByTestId("modem-gps-outcome");

		expect(
			screen.getByTestId("modem-fcc-unlock-announce-assertive").textContent,
		).toBe("");
		expect(
			screen.getByTestId("modem-fcc-unlock-announce-polite").textContent,
		).toBe("");
		expect(screen.queryByTestId("modem-fcc-unlock-outcome")).toBeNull();
	});
});
