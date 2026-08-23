// @vitest-environment jsdom
/**
 * ModemGpsSection — reachable for EVERY modem that reports the capability, and
 * honest about a capability nobody has looked for yet.
 *
 * `modem-gps.test.ts` proves the rules; what can only be proven here is what an
 * operator ends up looking at, and three of the four blocks below are about a
 * defect the rules could not have caught:
 *
 *  - the section was mounted by ONE of the two modem dialogs, so a claim carried
 *    by a router-family row contributed exactly as many nodes as a modem with no
 *    receiver: zero. The claim is a property of the MODEM, so the assertion is
 *    that the SAME claim renders the SAME surface whichever dialog opened it;
 *  - the evidence every GPS mutation gates on is process-local and resets on
 *    boot, so the first operator after a restart meets `enabled` — gate on,
 *    nothing probed. That state must say it is still looking AND dispatch the
 *    read that settles it, rather than reporting a verdict about the hardware
 *    that nobody has reached;
 *  - the device's acquisition bound is advanced only BY a read, so a modem that
 *    stops answering leaves the wire state on `acquiring` for as long as the
 *    dialog is open. The surface must reach `no-fix` on its own.
 *
 * The fourth is the ordinary refusal path: a modem that claims a receiver and
 * then fails to switch it on must say why, on screen.
 */

import type {
	GnssFixState,
	Modem,
	SupportClaimState,
} from "@ceraui/rpc/schemas";
import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import ModemGpsSection from "./ModemGpsSection.svelte";
import RouterDongleDialog from "./RouterDongleDialog.svelte";

const getGps = vi.hoisted(() => vi.fn());
const setGps = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { getGps, setGps, setRouterControl: vi.fn() } },
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

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

const OFF: GnssFixState = { kind: "off" };

beforeEach(() => {
	getGps.mockResolvedValue({
		success: true,
		status: {
			gnssCapable: true,
			gnssEnabled: false,
			capabilities: [],
			enabledSources: [],
		},
		state: OFF,
	});
	setGps.mockResolvedValue({
		success: true,
		status: {
			gnssCapable: true,
			gnssEnabled: true,
			capabilities: [],
			enabledSources: [],
		},
		state: OFF,
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
});

function mountSection(claim: SupportClaimState | undefined) {
	return render(ModemGpsSection, { props: { claim, deviceId: "modem-1" } });
}

/** A router-family row that claims a receiver — the family this could not reach. */
function dongle(claim: SupportClaimState) {
	return {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		capability_modules: { gps: claim },
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
		},
	} as unknown as Modem;
}

describe("the GPS surface is reachable for EVERY family that claims it", () => {
	it("renders for a router-family modem, from inside its own dialog", async () => {
		render(RouterDongleDialog, {
			props: { open: true, deviceId: "router-1", modem: dongle("capable") },
		});

		const section = await screen.findByTestId("modem-gps");
		expect(section.getAttribute("data-capability-state")).toBe("available");
		expect(screen.getAllByTestId("modem-gps-toggle")).toHaveLength(1);
	});

	it("renders the SAME state for the SAME claim, mounted standalone", async () => {
		mountSection("capable");

		const section = await screen.findByTestId("modem-gps");
		expect(section.getAttribute("data-capability-state")).toBe("available");
	});

	it.each(["unavailable", undefined] as const)(
		"contributes zero nodes AND dispatches no read for the %s claim",
		async (claim) => {
			render(RouterDongleDialog, {
				props: {
					open: true,
					deviceId: "router-1",
					modem: dongle(claim as SupportClaimState),
				},
			});
			await screen.findByTestId("dongle-status");

			expect(screen.queryAllByTestId("modem-gps")).toHaveLength(0);
			// A surface that says nothing must not ask anything either — reading at
			// a modem with no receiver is a request that can only ever be refused.
			expect(getGps).not.toHaveBeenCalled();
		},
	);
});

describe("a fresh boot has not probed this modem yet", () => {
	/**
	 * The evidence a GPS mutation gates on is process-local and resets on boot, so
	 * after a restart the gate is on and nothing has been probed — claim
	 * `enabled`. The section must not be the dead end that state used to be: it
	 * dispatches the read that settles it, and until then it says what is not yet
	 * known WITHOUT offering a control (CT-4) and WITHOUT reaching a verdict about
	 * the hardware.
	 */
	it("issues the read that settles the claim, with no control offered", async () => {
		let settle: ((value: unknown) => void) | undefined;
		getGps.mockImplementation(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);

		mountSection("enabled");

		const marker = await screen.findByTestId("modem-gps-unknown");
		expect(marker.getAttribute("role")).toBe("status");
		expect(marker.getAttribute("data-state")).toBe("unknown");
		expect(marker.textContent?.trim().length).toBeGreaterThan(0);
		expect(marker.textContent).not.toContain("network.modem.");
		expect(screen.queryAllByTestId("modem-gps-toggle")).toHaveLength(0);
		expect(getGps).toHaveBeenCalledWith({ device: "modem-1" });

		settle?.({ success: true, status: { gnssEnabled: false }, state: OFF });
	});

	/**
	 * CT-5 for this path, and the reason the sentence is not a per-mount
	 * "checking…" transient: the same evidence would then render two different
	 * ways depending on whether the read had answered when the operator looked.
	 */
	it("says the same thing whether or not the read has answered yet", async () => {
		let settle: ((value: unknown) => void) | undefined;
		getGps.mockImplementation(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		mountSection("enabled");
		const inFlight = (await screen.findByTestId("modem-gps-unknown")).outerHTML;
		settle?.({ success: false, error: "read_failed" });
		await waitFor(() => expect(getGps).toHaveBeenCalled());
		cleanup();

		getGps.mockResolvedValue({ success: false, error: "read_failed" });
		mountSection("enabled");
		await waitFor(() => expect(getGps).toHaveBeenCalledTimes(2));
		expect((await screen.findByTestId("modem-gps-unknown")).outerHTML).toBe(
			inFlight,
		);
	});
});

describe("the acquisition wait is bounded on screen, not only on the device", () => {
	/**
	 * The device declares the window with its OWN clock, so the surface measures
	 * elapsed time from when it first saw the wait — comparing a device timestamp
	 * against the browser's would be wrong by whatever the two disagree by.
	 */
	function acquiring(deviceNow: number, durationMs: number): GnssFixState {
		return {
			kind: "acquiring",
			since: deviceNow,
			deadline: deviceNow + durationMs,
		};
	}

	it("resolves to no-fix when the modem never answers again", async () => {
		vi.useFakeTimers();
		// A device clock hours away from the browser's: the bound must still land.
		const state = acquiring(Date.now() + 9_000_000, 30_000);
		getGps.mockResolvedValue({
			success: true,
			status: { gnssEnabled: true },
			state,
		});

		mountSection("capable");

		await vi.waitFor(() =>
			expect(screen.queryByTestId("modem-gps-acquiring")).not.toBeNull(),
		);

		await vi.advanceTimersByTimeAsync(31_000);

		expect(screen.queryAllByTestId("modem-gps-acquiring")).toHaveLength(0);
		const line = screen.getByTestId("modem-gps-no-fix");
		expect(line.textContent).not.toContain("network.modem.");
		expect(
			screen.getByTestId("modem-gps-state").getAttribute("data-gps-state"),
		).toBe("no-fix");
	});

	it("re-reads while the wait is live, and stops once it is over", async () => {
		vi.useFakeTimers();
		getGps.mockResolvedValue({
			success: true,
			status: { gnssEnabled: true },
			state: acquiring(Date.now(), 20_000),
		});

		mountSection("capable");
		await vi.waitFor(() => expect(getGps).toHaveBeenCalled());

		await vi.advanceTimersByTimeAsync(21_000);
		const duringWait = getGps.mock.calls.length;
		expect(duringWait).toBeGreaterThan(1);

		// Past the declared window nothing is armed, so the poll cannot outlive the
		// bound it serves.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(getGps.mock.calls.length).toBe(duringWait);
	});
});

describe("the whole operator flow, on one mounted surface", () => {
	it("enables, waits, shows the fix, and drops it again on disable", async () => {
		vi.useFakeTimers();
		const at = Date.now();
		const acquiring: GnssFixState = {
			kind: "acquiring",
			since: at,
			deadline: at + 120_000,
		};
		setGps.mockResolvedValueOnce({
			success: true,
			status: { gnssEnabled: true },
			state: acquiring,
		});

		mountSection("capable");
		const toggle = await screen.findByTestId("modem-gps-toggle");
		await waitFor(() => expect(getGps).toHaveBeenCalled());
		expect(
			screen.getByTestId("modem-gps-state").getAttribute("data-gps-state"),
		).toBe("off");

		toggle.click();
		await screen.findByTestId("modem-gps-acquiring");

		getGps.mockResolvedValue({
			success: true,
			status: { gnssEnabled: true },
			state: {
				kind: "fix",
				fix: {
					latitude: 4.60971,
					longitude: -74.08175,
					altitude: 2640,
					observedAt: at,
				},
			},
		});
		// The wait is re-read on its own cadence — nothing here re-opens the dialog.
		await vi.advanceTimersByTimeAsync(6_000);
		const fix = screen.getByTestId("modem-gps-fix");
		// LTR-forced and rendered at the device's own precision — the ONE place a
		// coordinate is on screen, and nothing accumulates beside it.
		expect(fix.getAttribute("dir")).toBe("ltr");
		expect(fix.textContent).toContain("4.609710, -74.081750");

		setGps.mockResolvedValueOnce({
			success: true,
			status: { gnssEnabled: false },
			state: OFF,
		});
		screen.getByTestId("modem-gps-toggle").click();

		await vi.waitFor(() =>
			expect(
				screen.getByTestId("modem-gps-state").getAttribute("data-gps-state"),
			).toBe("off"),
		);
		// The coordinate is GONE from the document, not merely unstyled.
		expect(screen.queryAllByTestId("modem-gps-fix")).toHaveLength(0);
		expect(document.body.textContent).not.toContain("4.609710");
	});
});

describe("a claimed receiver that refuses to switch on", () => {
	it("renders the device's reason rather than a silent no-op", async () => {
		setGps.mockResolvedValue({ success: false, error: "not_enabled" });
		mountSection("capable");

		const toggle = await screen.findByTestId("modem-gps-toggle");
		toggle.click();

		await waitFor(() =>
			expect(setGps).toHaveBeenCalledWith({
				device: "modem-1",
				enabled: true,
			}),
		);
		const band = await screen.findByTestId("modem-gps-outcome");
		expect(band.textContent?.trim().length).toBeGreaterThan(0);
		expect(band.textContent).not.toContain("network.modem.");
		expect(band.textContent).not.toContain("not_enabled");
	});
});
