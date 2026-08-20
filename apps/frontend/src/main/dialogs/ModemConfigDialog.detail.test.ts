// @vitest-environment jsdom
/**
 * ModemConfigDialog — the advanced surface, rendered.
 *
 * The suite is built around the FIELD-ABSENT MATRIX, because every card added
 * here is driven by a Phase-B additive-optional wire field and the failure mode
 * that actually ships is not a wrong number — it is a dialog that breaks, or
 * quietly grows an empty frame, on the mmcli payload that reports none of them.
 * So each card is proven to vanish INDEPENDENTLY while the dialog's own controls
 * stay intact, and then again with all of them gone at once.
 *
 * The other three properties are honesty locks:
 *   · the eSIM block must contain NO mutation affordance, asserted against the
 *     real DOM rather than by reading the markup;
 *   · the `uncertified` USB refusal is a first-class standing state, not a red
 *     error with a retry button that would refuse identically forever;
 *   · Auto-APN defaults to Automatic for an unconfigured modem and NEVER for one
 *     carrying a stored manual APN.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
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

const setUsbMode = vi.hoisted(() => vi.fn());
const connected = vi.hoisted(() => ({ value: true }));

// The switch control only exists for a device that reports a CERTIFIED target,
// so every refusal case below needs one to have something to be withdrawn.
const usbModeOptions = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			setUsbMode,
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
		getIsConnected: () => connected.value,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const KEY = "platform-xhci-hcd.0-usb-1:2";

/** A modem carrying EVERY Phase-B detail field — the maximal payload. */
function fullModem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 72,
			roaming: false,
		},
		stable_key: KEY,
		usb_mode: "qmi",
		recommended_usb_mode: "mbim",
		firmware_revision: "RM520NGLAAR01A08M4G",
		cell_info: {
			tech: "nr",
			band: "n78",
			cell_id: "0x1A2B3C",
			rsrp: -92,
			rsrq: -11,
			sinr: 18,
			provenance: { source: "qmi", observed_at: 1_770_000_000 },
		},
		esim: { sim_type: "esim", esim_status: "with-profiles" },
		data_usage: {
			session_bytes: 1_572_864,
			cycle_bytes: 3_221_225_472,
			cycle_day: 17,
			threshold_bytes: 10_737_418_240,
		},
		...overrides,
	} as Modem;
}

/**
 * The pre-Phase-B / mmcli payload: not one additive detail field on it. This is
 * what an older backend actually sends, and it must render a complete, working
 * dialog with three fewer cards.
 */
function legacyModem(): Modem {
	return {
		ifname: "wwan0",
		name: "Legacy Modem",
		network_type: { supported: ["4g"], active: "4g" },
		status: {
			connection: "connected",
			network_type: "4g",
			signal: 55,
			roaming: false,
		},
	} as Modem;
}

function mount(modem: Modem) {
	return render(ModemConfigDialog, {
		props: { open: true, modem, deviceId: "0" },
	});
}

/**
 * The dialog's own controls — proof it survived whatever card went missing.
 * The modem name renders twice by design (dialog title + status strip), so it
 * is counted rather than matched uniquely.
 */
function expectDialogIntact(): void {
	expect(screen.getAllByText("Quectel RM520N-GL").length).toBeGreaterThan(0);
	expect(screen.getByRole("switch", { name: /Allow Roaming/i })).toBeTruthy();
	expect(screen.getByRole("switch", { name: /Automatic APN/i })).toBeTruthy();
}

/** The manual APN input, mounted only while Automatic APN is off. */
function manualApnInput(): HTMLInputElement | null {
	return document.querySelector<HTMLInputElement>("#modem-apn");
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
	setUsbMode.mockReset();
	usbModeOptions.mockReset();
	usbModeOptions.mockResolvedValue({ certified: ["mbim", "ecm-ncm"] });
	resetModemsFeed();
	connected.value = true;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("field-absent matrix — every card vanishes on its own", () => {
	it("renders all three cards on the maximal payload", async () => {
		mount(fullModem());
		expect(await screen.findByTestId("modem-detail-card")).toBeTruthy();
		expect(screen.getByTestId("modem-usage-card")).toBeTruthy();
		expect(screen.getByTestId("modem-usb-mode-card")).toBeTruthy();
	});

	it("absent data_usage → usage card gone, detail + USB cards intact", async () => {
		mount(fullModem({ data_usage: undefined }));
		await screen.findByTestId("modem-detail-card");
		expect(screen.queryByTestId("modem-usage-card")).toBeNull();
		expect(screen.getByTestId("modem-usb-mode-card")).toBeTruthy();
		expectDialogIntact();
	});

	it("absent cell_info + esim + firmware → detail card gone, others intact", async () => {
		mount(
			fullModem({
				cell_info: undefined,
				esim: undefined,
				firmware_revision: undefined,
			}),
		);
		await screen.findByTestId("modem-usage-card");
		expect(screen.queryByTestId("modem-detail-card")).toBeNull();
		expect(screen.getByTestId("modem-usb-mode-card")).toBeTruthy();
		expectDialogIntact();
	});

	it("absent usb_mode + recommended → USB card gone, others intact", async () => {
		mount(fullModem({ usb_mode: undefined, recommended_usb_mode: undefined }));
		await screen.findByTestId("modem-detail-card");
		expect(screen.queryByTestId("modem-usb-mode-card")).toBeNull();
		expect(screen.getByTestId("modem-usage-card")).toBeTruthy();
		expectDialogIntact();
	});

	it("the LEGACY mmcli payload renders a complete dialog with no advanced cards", async () => {
		mount(legacyModem());
		await screen.findByRole("switch", { name: /Automatic APN/i });

		expect(screen.queryByTestId("modem-detail-card")).toBeNull();
		expect(screen.queryByTestId("modem-usage-card")).toBeNull();
		expect(screen.queryByTestId("modem-usb-mode-card")).toBeNull();

		// Nothing standing in for the missing readings — no dash, no zero-byte
		// figure, no empty framed section left behind.
		expect(screen.queryByTestId("modem-usage-session")).toBeNull();
		expect(screen.queryByTestId("modem-cell-info")).toBeNull();
		expect(screen.queryByTestId("modem-esim")).toBeNull();
		expect(screen.queryByTestId("modem-firmware")).toBeNull();

		expect(screen.getByRole("switch", { name: /Allow Roaming/i })).toBeTruthy();
		expect(screen.getAllByText("Legacy Modem").length).toBeGreaterThan(0);
	});

	it("a partially-populated cell_info drops only the rows it omits", async () => {
		mount(
			fullModem({
				cell_info: { tech: "lte", rsrp: -105 },
				esim: undefined,
				firmware_revision: undefined,
			}),
		);
		await screen.findByTestId("modem-cell-info");

		expect(screen.getByTestId("modem-cell-tech")).toBeTruthy();
		expect(screen.getByTestId("modem-cell-rsrp")).toBeTruthy();
		expect(screen.queryByTestId("modem-cell-sinr")).toBeNull();
		expect(screen.queryByTestId("modem-cell-band")).toBeNull();
		expect(screen.queryByTestId("modem-esim")).toBeNull();
		expect(screen.queryByTestId("modem-firmware")).toBeNull();
	});
});

describe("cell detail", () => {
	it("renders the readings in the mono data face with their own units", async () => {
		mount(fullModem());
		const rsrp = await screen.findByTestId("modem-cell-rsrp");

		expect(rsrp.textContent).toContain("-92");
		expect(rsrp.textContent).toContain("dBm");
		expect(rsrp.className).toContain("font-mono");

		expect(screen.getByTestId("modem-cell-sinr").textContent).toContain("dB");
		expect(screen.getByTestId("modem-cell-rsrq").textContent).toContain("-11");
		expect(screen.getByTestId("modem-cell-cell_id").textContent).toContain(
			"0x1A2B3C",
		);
		expect(screen.getByTestId("modem-cell-band").textContent).toContain("n78");
	});

	it("never renders a raw wire token for the radio technology", async () => {
		mount(fullModem());
		const tech = await screen.findByTestId("modem-cell-tech");
		expect(tech.textContent?.trim()).toBe("5G NR");
		expect(tech.textContent).not.toContain("nr");
	});

	it("states WHEN the readings were taken", async () => {
		mount(fullModem());
		expect(
			(await screen.findByTestId("modem-cell-observed")).textContent,
		).toMatch(/Measured/i);
	});

	it("says so honestly when the modem reported no measurement time", async () => {
		mount(fullModem({ cell_info: { tech: "lte", rsrp: -90 } }));
		expect(
			(await screen.findByTestId("modem-cell-observed")).textContent,
		).toMatch(/did not report when/i);
	});

	it("renders the firmware revision when present", async () => {
		mount(fullModem());
		expect((await screen.findByTestId("modem-firmware")).textContent).toContain(
			"RM520NGLAAR01A08M4G",
		);
	});
});

describe("eSIM badge is READ-ONLY — no mutation affordance, ever", () => {
	it("renders the SIM kind and profile state as badges", async () => {
		mount(fullModem());
		const block = await screen.findByTestId("modem-esim");
		expect(within(block).getByTestId("modem-esim-type").textContent).toContain(
			"eSIM",
		);
		expect(
			within(block).getByTestId("modem-esim-status").textContent,
		).toContain("Profile installed");
		expect(
			within(block).getByTestId("modem-esim-readonly").textContent,
		).toMatch(/carrier/i);
	});

	it("contains NO interactive element of any kind", async () => {
		mount(fullModem());
		const block = await screen.findByTestId("modem-esim");

		expect(
			block.querySelectorAll(
				'button, a, input, select, textarea, summary, [role="button"], [role="switch"], [role="link"], [role="menuitem"], [contenteditable="true"]',
			),
		).toHaveLength(0);
		expect(within(block).queryAllByRole("button")).toHaveLength(0);
		expect(block.querySelector("[onclick]")).toBeNull();
		expect(block.getAttribute("tabindex")).toBeNull();
		expect(
			Array.from(block.querySelectorAll("[tabindex]")).filter(
				(el) => Number(el.getAttribute("tabindex")) >= 0,
			),
		).toHaveLength(0);
	});

	it("distinguishes a physical SIM without offering anything to do about it", async () => {
		mount(fullModem({ esim: { sim_type: "physical" } }));
		const block = await screen.findByTestId("modem-esim");
		expect(within(block).getByTestId("modem-esim-type").textContent).toContain(
			"Physical SIM",
		);
		expect(within(block).queryByTestId("modem-esim-status")).toBeNull();
		expect(within(block).queryAllByRole("button")).toHaveLength(0);
	});
});

describe("usage card — display only", () => {
	it("renders both counters, each with its own scope stated", async () => {
		mount(fullModem());
		expect(
			(await screen.findByTestId("modem-usage-session")).textContent,
		).toContain("1.5 MB");
		expect(screen.getByTestId("modem-usage-cycle").textContent).toContain(
			"3 GB",
		);
		expect(screen.getByTestId("modem-usage-card").textContent).toMatch(
			/Since the device last started/i,
		);
		expect(screen.getByTestId("modem-usage-card").textContent).toMatch(
			/Since the billing cycle started/i,
		);
	});

	it("renders a measured zero as a real reading, never as an absence", async () => {
		mount(
			fullModem({
				data_usage: { session_bytes: 0, cycle_bytes: 0 },
			}),
		);
		expect(
			(await screen.findByTestId("modem-usage-session")).textContent,
		).toContain("0 B");
		expect(screen.getByTestId("modem-usage-cycle").textContent).toContain(
			"0 B",
		);
	});

	it("reports the cycle day read-only when the device supplies one", async () => {
		mount(fullModem());
		expect(
			(await screen.findByTestId("modem-usage-cycle-day")).textContent,
		).toContain("17");
	});

	it("omits the cycle-day line when the device supplies none", async () => {
		mount(
			fullModem({
				data_usage: { session_bytes: 10, cycle_bytes: 20 },
			}),
		);
		await screen.findByTestId("modem-usage-card");
		expect(screen.queryByTestId("modem-usage-cycle-day")).toBeNull();
		expect(screen.queryByTestId("modem-usage-threshold")).toBeNull();
	});

	it("draws the advisory limit and says it gates nothing", async () => {
		mount(fullModem());
		const threshold = await screen.findByTestId("modem-usage-threshold");
		expect(
			within(threshold).getByTestId("modem-usage-threshold-value").textContent,
		).toContain("10 GB");
		expect(
			within(threshold).getByTestId("modem-usage-threshold-bar").dataset
				.percent,
		).toBe("30");
		expect(
			within(threshold).getByTestId("modem-usage-threshold-note").textContent,
		).toMatch(/nothing stops/i);
	});

	it("an exceeded limit is stated and still blocks nothing", async () => {
		mount(
			fullModem({
				data_usage: {
					session_bytes: 1,
					cycle_bytes: 20_000_000_000,
					threshold_bytes: 10_737_418_240,
				},
			}),
		);
		const note = await screen.findByTestId("modem-usage-threshold-note");
		expect(note.textContent).toMatch(/Nothing has been blocked/i);
		expect(
			screen.getByTestId("modem-usage-threshold-bar").dataset.percent,
		).toBe("100");
	});

	// REPLACES the retired "offers NO cycle-day or threshold CONTROL" case. The
	// behaviour it locked — a declared deferral instead of a control — was removed
	// because the write path now exists (`TD-modem-usage-policy-write` resolved),
	// so the same ground is covered here by asserting the real controls and, below,
	// the honest refusal on a device that cannot apply one.
	it("offers a real cycle-day picker and threshold input, seeded from the device", async () => {
		mount(
			fullModem({
				data_usage_policy: {
					supported: true,
					cycle_day: 17,
					threshold_bytes: 10_737_418_240,
				},
			}),
		);
		const policy = await screen.findByTestId("modem-usage-policy");

		const day = within(policy).getByTestId(
			"modem-usage-cycle-day-select",
		) as HTMLSelectElement;
		expect(day.disabled).toBe(false);
		expect(day.value).toBe("17");

		const threshold = within(policy).getByTestId(
			"modem-usage-threshold-input",
		) as HTMLInputElement;
		expect(threshold.disabled).toBe(false);
		// 10 GiB, in the SAME unit the meter renders it in.
		expect(threshold.value).toBe("10");

		expect(policy.querySelector("[data-debt-id]")).toBeNull();
	});

	it("disables the controls WITH A REASON when the device cannot apply a policy", async () => {
		mount(fullModem({ data_usage_policy: { supported: false } }));
		const policy = await screen.findByTestId("modem-usage-policy");

		expect(
			(
				within(policy).getByTestId(
					"modem-usage-cycle-day-select",
				) as HTMLSelectElement
			).disabled,
		).toBe(true);
		expect(
			(
				within(policy).getByTestId(
					"modem-usage-threshold-input",
				) as HTMLInputElement
			).disabled,
		).toBe(true);
		expect(
			within(policy).getByTestId("modem-usage-policy-unsupported").textContent,
		).toMatch(/update the device/i);
	});

	it("renders the policy controls on a modem that reports NO counters at all", async () => {
		// The case every board in the field is in: no shipped device runs the
		// backend that folds `data_usage` onto the wire, so gating the controls on
		// the counters would hide them everywhere.
		mount(
			fullModem({
				data_usage: undefined,
				data_usage_policy: { supported: true },
			}),
		);

		expect(await screen.findByTestId("modem-usage-policy")).toBeTruthy();
		expect(screen.queryByTestId("modem-usage-figures")).toBeNull();
	});

	it("omits the policy block entirely when the device publishes none", async () => {
		mount(fullModem({ data_usage_policy: undefined }));
		await screen.findByTestId("modem-usage-card");

		expect(screen.queryByTestId("modem-usage-policy")).toBeNull();
	});

	it("dims the figures and says so when the connection that delivers them is down", async () => {
		connected.value = false;
		mount(fullModem());

		const figures = await screen.findByTestId("modem-usage-figures");
		expect(figures.dataset.stale).toBe("true");
		expect(figures.className).toContain("opacity-50");
		expect(screen.getByTestId("modem-usage-stale").textContent).toMatch(
			/before the connection dropped/i,
		);
	});

	it("shows no staleness marker while the connection is up", async () => {
		mount(fullModem());
		const figures = await screen.findByTestId("modem-usage-figures");
		expect(figures.dataset.stale).toBeUndefined();
		expect(screen.queryByTestId("modem-usage-stale")).toBeNull();
	});
});

describe("Auto-APN default", () => {
	it("an UNCONFIGURED modem opens on Automatic, with the recommendation shown", async () => {
		mount(fullModem({ config: undefined }));
		const toggle = await screen.findByRole("switch", {
			name: /Automatic APN/i,
		});

		expect(toggle.getAttribute("aria-checked")).toBe("true");
		expect(screen.getByTestId("modem-autoapn-recommended").textContent).toMatch(
			/Recommended/i,
		);
		// Automatic is on, so the manual APN field is not even mounted.
		expect(manualApnInput()).toBeNull();
	});

	it("a config with no flag and no stored APN also opens on Automatic", async () => {
		mount(
			fullModem({
				config: {
					apn: "",
					username: "",
					password: "",
					roaming: false,
					network: "",
				},
			}),
		);
		expect(
			(
				await screen.findByRole("switch", { name: /Automatic APN/i })
			).getAttribute("aria-checked"),
		).toBe("true");
	});

	it("a STORED manual APN is never silently flipped to Automatic", async () => {
		mount(
			fullModem({
				config: {
					apn: "internet.provider.com",
					username: "",
					password: "",
					roaming: false,
					network: "",
				},
			}),
		);
		expect(
			(
				await screen.findByRole("switch", { name: /Automatic APN/i })
			).getAttribute("aria-checked"),
		).toBe("false");
		expect(manualApnInput()?.value).toBe("internet.provider.com");
	});

	it("an explicit autoconfig:false wins over the recommended default", async () => {
		mount(
			fullModem({
				config: {
					apn: "",
					username: "",
					password: "",
					roaming: false,
					network: "",
					autoconfig: false,
				},
			}),
		);
		expect(
			(
				await screen.findByRole("switch", { name: /Automatic APN/i })
			).getAttribute("aria-checked"),
		).toBe("false");
	});
});

describe("the `uncertified` USB refusal is a FIRST-CLASS state", () => {
	async function refuseWith(error: string, reason?: string): Promise<void> {
		setUsbMode.mockResolvedValue(
			reason === undefined
				? { success: false, error }
				: { success: false, error, reason },
		);
		publishModems({ "0": fullModem() });
		mount(fullModem());

		await fireEvent.click(await screen.findByText(/Switch to mbim/i));
		await fireEvent.click(
			await screen.findByRole("button", { name: /Switch mode/i }),
		);
		await waitFor(() => expect(setUsbMode).toHaveBeenCalled());
	}

	it("renders its own copy, calmly, and explains what still works", async () => {
		await refuseWith("uncertified");

		const band = await screen.findByTestId("modem-usb-mode-error");
		expect(band.dataset.usbModeRefusal).toBe("uncertified");
		expect(band.textContent).toMatch(/certified/i);
		expect(band.textContent).toMatch(/keeps working normally/i);
	});

	it("is a status, not an alert — nothing failed, this device just cannot switch", async () => {
		await refuseWith("uncertified");
		const band = await screen.findByTestId("modem-usb-mode-error");

		expect(band.getAttribute("role")).toBe("status");
		expect(band.className).not.toContain("text-status-error");
	});

	it("WITHDRAWS the switch control — a retry would refuse identically", async () => {
		await refuseWith("uncertified");
		await screen.findByTestId("modem-usb-mode-error");

		expect(screen.queryByText(/Switch to mbim/i)).toBeNull();
		// The active mode is still reported, and still reads the pre-attempt value.
		expect(screen.getByTestId("modem-usb-mode-active").textContent).toContain(
			"qmi",
		);
	});

	it("treats a provisioning-disabled device the same way", async () => {
		await refuseWith("provisioning_disabled");

		const band = await screen.findByTestId("modem-usb-mode-error");
		expect(band.dataset.usbModeRefusal).toBe("provisioning_disabled");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).toMatch(/turned off/i);
		expect(screen.queryByText(/Switch to mbim/i)).toBeNull();
	});

	it("a RECOVERABLE refusal keeps the red band AND keeps the button", async () => {
		await refuseWith("transition_failed", "preconditions_refused");

		const band = await screen.findByTestId("modem-usb-mode-error");
		expect(band.dataset.usbModeRefusal).toBeUndefined();
		expect(band.getAttribute("role")).toBe("alert");
		expect(band.className).toContain("text-status-error");
		expect(screen.getByText(/Switch to mbim/i)).toBeTruthy();
	});
});

/**
 * Todo 46 — the outstanding-lock band.
 *
 * Only a NON-BLOCKING lock can reach this dialog (the row routes a blocking one
 * straight to unlock), and that gate is what keeps the band's copy honest: it
 * tells the operator their service is unaffected, which is true of the `2`
 * variants and false of PIN1/PUK1. It must also never GATE anything — the
 * operator opened a working modem's settings and is entitled to them.
 */
describe("ModemConfigDialog — outstanding SIM lock (todo 46)", () => {
	function lockedModem(required: string): Modem {
		const base = fullModem();
		return { ...base, sim_lock: { required, remainingAttempts: 3 } } as Modem;
	}

	function mountLocked(required: string, onUnlock = vi.fn()) {
		const view = render(ModemConfigDialog, {
			props: {
				open: true,
				modem: lockedModem(required),
				deviceId: "0",
				onUnlock,
			},
		});
		return { ...view, onUnlock };
	}

	it.each(["sim-pin2", "sim-puk2"])(
		"%s reports the lock and offers the unlock beside the settings",
		(required) => {
			mountLocked(required);
			const band = screen.getByTestId("modem-locked-band");
			expect(band.getAttribute("data-sim-lock")).toBe(required);
			// Calm status, never an alert — nothing is wrong with this modem.
			expect(band.getAttribute("role")).toBe("status");
			expect(screen.getByTestId("modem-locked-unlock")).toBeTruthy();
			expectDialogIntact();
		},
	);

	it("hands off to the unlock flow when the band's action is pressed", async () => {
		const { onUnlock } = mountLocked("sim-pin2");
		await fireEvent.click(screen.getByTestId("modem-locked-unlock"));
		expect(onUnlock).toHaveBeenCalledTimes(1);
	});

	it.each(["sim-pin", "sim-puk"])(
		"%s draws NO band — its copy would be a lie, and the row never routes it here",
		(required) => {
			mountLocked(required);
			expect(screen.queryByTestId("modem-locked-band")).toBeNull();
			expectDialogIntact();
		},
	);

	it("draws no band for an unlocked modem", () => {
		render(ModemConfigDialog, {
			props: {
				open: true,
				modem: fullModem(),
				deviceId: "0",
				onUnlock: vi.fn(),
			},
		});
		expect(screen.queryByTestId("modem-locked-band")).toBeNull();
	});

	it("stays absent when the host offers no unlock route", () => {
		// A band whose only action cannot fire would be a dead end.
		render(ModemConfigDialog, {
			props: { open: true, modem: lockedModem("sim-pin2"), deviceId: "0" },
		});
		expect(screen.queryByTestId("modem-locked-band")).toBeNull();
	});

	it("gates NOTHING — the lock is an offer, not a lock on the form", () => {
		mountLocked("sim-pin2");
		expect(
			screen
				.getByRole("switch", { name: /Allow Roaming/i })
				.hasAttribute("disabled"),
		).toBe(false);
		expect(
			screen
				.getByRole("switch", { name: /Automatic APN/i })
				.hasAttribute("disabled"),
		).toBe(false);
	});
});
