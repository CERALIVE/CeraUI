// @vitest-environment jsdom
/**
 * RouterDongleDialog — what an operator is left with AFTER a write (pass 2).
 *
 * Pass 1 settled what this surface OFFERS. These tests are about the seconds
 * after the operator acts, which is where the surface was quietest:
 *
 *  · THE OUTCOME WAS A TOAST. On a pessimistic surface a refused write correctly
 *    leaves the control unmoved, so the toast was the ONLY thing separating
 *    "refused" from "never attempted" — and it expired. Every assertion below
 *    that says "still there after a re-render" is testing exactly that: the band
 *    must survive the next observation, because the next observation is what an
 *    operator watching a live device gets several of per minute.
 *  · THE WAIT HAD NO BOUND. With no confirming broadcast the spinner simply
 *    stopped. There is now a third answer, and it must be REACHABLE, TERMINAL,
 *    and DISTINCT from both success and refusal.
 *  · A STALE READING LOOKED FRESH. `router_admin.signal.freshness` has carried
 *    the distinction since todo 20; this dialog printed the numbers with no
 *    marker at all (§2 IH-4).
 *
 * Every outcome is also asserted as ANNOUNCED, in the right politeness class —
 * a band a screen-reader operator never hears is the same defect one layer down.
 */
import type { Modem, RouterAdmin } from "@ceraui/rpc/schemas";
import { render, screen } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { ROUTER_WRITE_CONFIRM_WINDOW_MS } from "$lib/rpc/router-write-flow";

import RouterDongleDialog from "./RouterDongleDialog.svelte";

const setRouterControl = vi.hoisted(() => vi.fn());
const setRouterNetMode = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { setRouterControl, setRouterNetMode } },
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

beforeEach(() => {
	setRouterControl.mockReset();
	setRouterNetMode.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

/** The bench HiLink: the one dialect whose writes were proven by round trip. */
function hilink(admin: Partial<RouterAdmin> = {}): Modem {
	return {
		ifname: "eth1",
		name: "Huawei E3372",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
			controls: { mobile_data: false, roaming_autoconnect: false },
			...admin,
		},
	} as unknown as Modem;
}

const controls = (mobileData: boolean) => ({
	controls: { mobile_data: mobileData, roaming_autoconnect: false },
});

function mount(modem: Modem) {
	return render(RouterDongleDialog, {
		props: { open: true, deviceId: "router-1", modem },
	});
}

function toggleMobileData(): void {
	const control = document.querySelector(
		'[data-testid="dongle-control-mobile_data"] [role="switch"]',
	) as HTMLElement | null;
	if (control === null) throw new Error("mobile-data switch not rendered");
	control.click();
}

const band = () => screen.queryByTestId("dongle-control-write-outcome");
const polite = () => screen.getByTestId("dongle-control-write-announce-polite");
const assertive = () =>
	screen.getByTestId("dongle-control-write-announce-assertive");

describe("LR-1 — the regions exist before anything can announce into them", () => {
	it("mounts both politeness classes with the surface, not with the outcome", () => {
		mount(hilink());

		expect(polite().getAttribute("aria-live")).toBe("polite");
		expect(polite().getAttribute("role")).toBe("status");
		expect(assertive().getAttribute("aria-live")).toBe("assertive");
		expect(assertive().getAttribute("role")).toBe("alert");
		// Nothing has happened yet, so neither carries a sentence.
		expect(polite().textContent).toBe("");
		expect(assertive().textContent).toBe("");
		expect(band()).toBeNull();
	});
});

describe("a confirmed write PERSISTS, and it persists through later observations", () => {
	it("renders `applied` only once the DEVICE reports the new value", async () => {
		setRouterControl.mockResolvedValue({ success: true });
		const { rerender } = mount(hilink());

		toggleMobileData();
		await vi.waitFor(() => expect(setRouterControl).toHaveBeenCalled());

		// The reply alone is not the proof this surface renders: until the
		// observation lands there is no terminal outcome at all.
		expect(band()).toBeNull();

		await rerender({ modem: hilink(controls(true)) });
		const applied = await screen.findByTestId("dongle-control-write-outcome");
		expect(applied.getAttribute("data-outcome")).toBe("applied");
		expect(applied.textContent?.trim().length).toBeGreaterThan(0);
	});

	// THE POINT OF THE WHOLE CHANGE. A toast is gone four seconds later; an
	// operator looking at a live dongle receives an observation long before that.
	it("survives an unrelated observation update — it is not a transient", async () => {
		setRouterControl.mockResolvedValue({ success: true });
		const { rerender } = mount(hilink());

		toggleMobileData();
		await vi.waitFor(() => expect(setRouterControl).toHaveBeenCalled());
		await rerender({ modem: hilink(controls(true)) });
		const first = (await screen.findByTestId("dongle-control-write-outcome"))
			.textContent;

		for (const signalBars of [1, 2, 3]) {
			await rerender({
				modem: hilink({ ...controls(true), signal_bars: signalBars }),
			});
		}

		const still = screen.getByTestId("dongle-control-write-outcome");
		expect(still.getAttribute("data-outcome")).toBe("applied");
		expect(still.textContent).toBe(first);
	});

	it("announces a success POLITELY, and never in the assertive region (LR-2)", async () => {
		setRouterControl.mockResolvedValue({ success: true });
		const { rerender } = mount(hilink());

		toggleMobileData();
		await vi.waitFor(() => expect(setRouterControl).toHaveBeenCalled());
		await rerender({ modem: hilink(controls(true)) });
		await screen.findByTestId("dongle-control-write-outcome");

		expect(polite().textContent?.trim().length).toBeGreaterThan(0);
		expect(assertive().textContent).toBe("");
	});
});

describe("a refusal is stated, kept, and announced assertively", () => {
	it("renders the device's own typed reason and leaves the control where it was", async () => {
		setRouterControl.mockResolvedValue({
			success: false,
			error: "not_applied",
		});
		const { rerender } = mount(hilink());

		toggleMobileData();

		const refused = await screen.findByTestId("dongle-control-write-outcome");
		expect(refused.getAttribute("data-outcome")).toBe("refused");
		expect(refused.textContent).toMatch(/old value|nothing was changed/i);
		expect(
			screen
				.getByTestId("dongle-control-mobile_data")
				.getAttribute("data-checked"),
		).toBe("false");

		expect(assertive().textContent?.trim().length).toBeGreaterThan(0);
		expect(polite().textContent).toBe("");

		// And it does not evaporate on the next tick of the feed.
		await rerender({ modem: hilink({ ...controls(false), signal_bars: 4 }) });
		expect(
			screen
				.getByTestId("dongle-control-write-outcome")
				.getAttribute("data-outcome"),
		).toBe("refused");
	});

	it("a thrown call reads as the dongle never answering, not as a success", async () => {
		setRouterControl.mockRejectedValue(new Error("socket closed"));
		mount(hilink());

		toggleMobileData();

		const refused = await screen.findByTestId("dongle-control-write-outcome");
		expect(refused.getAttribute("data-outcome")).toBe("refused");
		expect(refused.textContent).toMatch(/didn't answer|did not answer/i);
	});
});

describe("BOUNDED CONFIRMATION — the wait always ends somewhere the operator can read", () => {
	it("a confirmation that never arrives renders the reconciliation state, never success", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setRouterControl.mockResolvedValue({ success: true });
		mount(hilink());

		toggleMobileData();
		await vi.waitFor(() => expect(setRouterControl).toHaveBeenCalled());

		// Mid-window: still waiting, and deliberately still no terminal band.
		await vi.advanceTimersByTimeAsync(ROUTER_WRITE_CONFIRM_WINDOW_MS / 2);
		expect(band()).toBeNull();

		await vi.advanceTimersByTimeAsync(ROUTER_WRITE_CONFIRM_WINDOW_MS);

		await vi.waitFor(() =>
			expect(band()?.getAttribute("data-outcome")).toBe("unknown"),
		);
		const unknown = screen.getByTestId("dongle-control-write-outcome");
		expect(unknown.getAttribute("data-outcome")).not.toBe("applied");
		expect(unknown.textContent?.trim().length).toBeGreaterThan(0);
		// The switch never moved: nothing here claims the device changed.
		expect(
			screen
				.getByTestId("dongle-control-mobile_data")
				.getAttribute("data-checked"),
		).toBe("false");
	});

	it("the unknown outcome interrupts, because it is the one to act on", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setRouterControl.mockResolvedValue({ success: true });
		mount(hilink());

		toggleMobileData();
		await vi.waitFor(() => expect(setRouterControl).toHaveBeenCalled());
		await vi.advanceTimersByTimeAsync(ROUTER_WRITE_CONFIRM_WINDOW_MS + 1_000);

		await vi.waitFor(() =>
			expect(assertive().textContent?.trim().length).toBeGreaterThan(0),
		);
		expect(polite().textContent).toBe("");
	});

	it("the control is locked while the write is unresolved, and released after", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setRouterControl.mockResolvedValue({ success: true });
		mount(hilink());

		toggleMobileData();
		await vi.waitFor(() => expect(setRouterControl).toHaveBeenCalled());

		const roaming = document.querySelector(
			'[data-testid="dongle-control-roaming_autoconnect"] [role="switch"]',
		) as HTMLElement;
		expect(roaming.hasAttribute("disabled")).toBe(true);

		await vi.advanceTimersByTimeAsync(ROUTER_WRITE_CONFIRM_WINDOW_MS + 1_000);
		await vi.waitFor(() =>
			expect(band()?.getAttribute("data-outcome")).toBe("unknown"),
		);
		expect(
			(
				document.querySelector(
					'[data-testid="dongle-control-roaming_autoconnect"] [role="switch"]',
				) as HTMLElement
			).hasAttribute("disabled"),
		).toBe(false);
	});
});

describe("the net-mode write reports on its OWN surface", () => {
	function withModes(current: string): Modem {
		return {
			ifname: "eth1",
			name: "Huawei E3372",
			router_admin: {
				admin_url: "http://192.168.8.1",
				reachable: true,
				capabilities: {
					net_mode: {
						state: "reported",
						modes: [
							{ id: "00", name: "AUTO" },
							{ id: "03", name: "LTE" },
						],
						current,
					},
				},
			},
		} as unknown as Modem;
	}

	it("a refused mode change bands under the mode chips, not under the toggles", async () => {
		setRouterNetMode.mockResolvedValue({
			success: false,
			error: "capability_unavailable",
			code: "112008",
		});
		mount(withModes("00"));

		screen.getByTestId("dongle-net-mode-03").click();

		const refused = await screen.findByTestId("dongle-mode-write-outcome");
		expect(refused.getAttribute("data-outcome")).toBe("refused");
		// The firmware's own code reaches the operator rather than a euphemism.
		expect(refused.textContent).toContain("112008");
		expect(screen.queryByTestId("dongle-control-write-outcome")).toBeNull();
	});

	it("confirms on the device's own current mode, and keeps the band", async () => {
		setRouterNetMode.mockResolvedValue({ success: true });
		const { rerender } = mount(withModes("00"));

		screen.getByTestId("dongle-net-mode-03").click();
		await vi.waitFor(() => expect(setRouterNetMode).toHaveBeenCalled());
		expect(screen.queryByTestId("dongle-mode-write-outcome")).toBeNull();

		await rerender({ modem: withModes("03") });
		const applied = await screen.findByTestId("dongle-mode-write-outcome");
		expect(applied.getAttribute("data-outcome")).toBe("applied");

		await rerender({ modem: withModes("03") });
		expect(
			screen
				.getByTestId("dongle-mode-write-outcome")
				.getAttribute("data-outcome"),
		).toBe("applied");
	});
});

describe("§2 IH-4 — a stale reading is MARKED, and an absent one is a state", () => {
	const signal = (freshness: "live" | "stale" | "unknown") => ({
		signal: {
			provenance: "hilink-admin-api" as const,
			freshness,
			bars: { state: "known" as const, value: 3 },
			max_bars: { state: "known" as const, value: 5 },
			dbm: { state: "unknown" as const, reason: "unsupported" as const },
			rsrp: { state: "unknown" as const, reason: "unsupported" as const },
			rsrq: { state: "unknown" as const, reason: "unsupported" as const },
			snr: { state: "unknown" as const, reason: "unsupported" as const },
			sinr: { state: "unknown" as const, reason: "unsupported" as const },
		},
	});

	it("marks a device-stated stale reading WITHOUT blanking the values", () => {
		mount(hilink(signal("stale")));

		const marker = screen.getByTestId("dongle-stale");
		expect(marker.getAttribute("data-freshness")).toBe("stale");
		expect(marker.getAttribute("role")).toBe("status");
		expect(marker.textContent?.trim().length).toBeGreaterThan(0);
		// The identity grid is still on screen — a stale reading is dimmed, not
		// withheld, and it is never replaced by a spinner.
		expect(screen.getByTestId("dongle-identity")).not.toBeNull();
		expect(document.querySelector('[role="progressbar"]')).toBeNull();
	});

	it("marks NOTHING for a live reading", () => {
		mount(hilink(signal("live")));
		expect(screen.queryByTestId("dongle-stale")).toBeNull();
	});

	// `unknown` is the device telling us nothing about the reading's age. A
	// "stale" badge over that is a claim we cannot make.
	it("marks NOTHING for an unknown freshness", () => {
		mount(hilink(signal("unknown")));
		expect(screen.queryByTestId("dongle-stale")).toBeNull();
	});

	it("a device that reported nothing at all gets a band, not a blank dialog", () => {
		mount({ ifname: "eth1", name: "Huawei E3372" } as unknown as Modem);

		const unavailable = screen.getByTestId("dongle-unavailable");
		expect(unavailable.getAttribute("role")).toBe("status");
		expect(unavailable.textContent?.trim().length).toBeGreaterThan(0);
		expect(document.querySelector('[role="progressbar"]')).toBeNull();
	});
});

describe("OL-2/OL-3/OL-4 — the raw tokens moved, they did not disappear", () => {
	const withDetails = () =>
		hilink({
			details: {
				network_type: "LTE",
				registration: "REGISTERED",
				band: "B4",
				network_mode: "1",
				cell_id: "134318388",
			},
		});

	/** Text an operator reads, with every marked diagnostics subtree removed. */
	function operatorText(): string {
		const root = document.body.cloneNode(true) as HTMLElement;
		for (const node of root.querySelectorAll('[data-testid*="diagnostic"]')) {
			node.remove();
		}
		return root.textContent ?? "";
	}

	it("keeps a raw band token out of operator-facing text", () => {
		mount(withDetails());

		expect(operatorText()).not.toContain("B4");
		expect(operatorText()).not.toContain("134318388");
		// The operator half still says what an operator can act on.
		expect(operatorText()).toContain("LTE");
	});

	it("still renders every one of them, verbatim, inside the marked block", () => {
		mount(withDetails());

		expect(screen.getByTestId("dongle-diagnostics")).not.toBeNull();
		expect(screen.getByTestId("dongle-detail-band").textContent?.trim()).toBe(
			"B4",
		);
		expect(
			screen.getByTestId("dongle-detail-cell_id").textContent?.trim(),
		).toBe("134318388");
		expect(
			screen.getByTestId("dongle-detail-network_mode").textContent?.trim(),
		).toBe("1");
	});

	// OL-4: collapsed by default. `CollapsibleSection` keeps the body mounted and
	// `inert`, which is what makes the assertion above legal AND the block quiet.
	it("is collapsed by default", () => {
		mount(withDetails());

		expect(
			screen
				.getByTestId("dongle-diagnostics-toggle")
				.getAttribute("aria-expanded"),
		).toBe("false");
		expect(screen.getByTestId("dongle-diagnostics-body").inert).toBe(true);
	});

	// `model` joined the override list when the unit table was demoted into this
	// block: it IS relocatable hardware trivia, so a fixture carrying one no
	// longer expresses this test's own premise. The assertion is unchanged.
	it("renders no diagnostics block for a device that stated none of them", () => {
		mount(hilink({ details: { network_type: "LTE" }, model: undefined }));
		expect(screen.queryByTestId("dongle-diagnostics")).toBeNull();
	});
});
