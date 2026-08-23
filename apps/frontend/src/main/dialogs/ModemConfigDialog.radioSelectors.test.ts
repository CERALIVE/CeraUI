// @vitest-environment jsdom
/**
 * THE THREE RADIO SELECTORS, RENDERED — unknown vs absent vs blocked.
 *
 * `modem-radio-selectors.test.ts` proves the RULE. This proves the markup obeys
 * it, and that split is what makes the fix checkable at all: the defect lived
 * entirely in the rendering. `deriveBandOffer` has always answered
 * `phase: "unknown"` for a read that threw; the card rendered it through a
 * two-state helper as `absent`, so the operator was shown ZERO nodes — the same
 * surface a modem with positively no band support gets.
 *
 * Absence has no syntax to grep for, so every claim here is counted: a state
 * that must render nothing is asserted at length 0, and a state that must speak
 * is asserted to carry a resolved sentence rather than a dotted key.
 */

import type { CapabilityModuleClaims, Modem } from "@ceraui/rpc/schemas";
import { CAPABILITY_MODULES } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
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

const getBands = vi.hoisted(() => vi.fn());
const getUsbModeOptions = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			getBands,
			getUsbModeOptions,
			getFccUnlock: vi.fn(async () => ({ success: false })),
			getGps: vi.fn(async () => ({ success: false })),
			getSms: vi.fn(async () => ({ success: true, messages: [] })),
			setBands: vi.fn(),
			setUsbMode: vi.fn(),
			setFiveGPreference: vi.fn(),
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

/** Every module `unavailable` unless the fixture says otherwise — fail-closed. */
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
		name: "Quectel RM530N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 72,
			roaming: false,
		},
		stable_key: "platform-xhci-hcd.0-usb-1:4",
		...overrides,
	} as Modem;
}

/**
 * The bench Fibocom FM350-GL, from its own `mmcli` dump: ONE supported-mode
 * combination (`allowed: 2g, 3g, 4g, 5g; preferred: none`), and no capability
 * matrix, so nothing has claimed a 5G posture surface for it.
 */
function fm350(): Modem {
	return modem({
		name: "Fibocom FM350-GL",
		network_type: { supported: ["2g3g4g5g"], active: "2g3g4g5g" },
		status: {
			connection: "connected",
			network_type: "4g",
			signal: 55,
			roaming: false,
		},
		capability_modules: undefined,
		five_g_preference: undefined,
	} as Partial<Modem>);
}

function mount(subject: Modem) {
	publishModems({ "0": subject });
	return render(ModemConfigDialog, {
		props: { open: true, modem: subject, deviceId: "0" },
	});
}

function state(testid: string): string | null {
	return screen.getByTestId(testid).getAttribute("data-capability-state");
}

/** A rendered reason: on screen, resolved, and not a raw dotted key. */
function expectSpeaks(testid: string): HTMLElement {
	const node = screen.getByTestId(testid);
	expect(node.textContent?.trim().length ?? 0).toBeGreaterThan(0);
	expect(node.textContent).not.toContain("network.modem.");
	return node;
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
	// bits-ui's Select opens on `pointerdown` and asks the target whether it
	// holds pointer capture. jsdom implements neither, so without these three the
	// menu never opens and the option count is unassertable.
	const proto = Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= () => false;
	proto.setPointerCapture ??= () => {};
	proto.releasePointerCapture ??= () => {};
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as never;
});

/** The menu is portalled and only exists while open, so it has to be opened. */
async function openNetworkTypeSelect(): Promise<void> {
	const trigger = screen.getByTestId("modem-network-type-trigger");
	await fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
	await fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0 });
	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="modem-network-type-option-"]')
				.length,
		).toBeGreaterThan(0);
	});
}

beforeEach(() => {
	resetModemsFeed();
	getBands.mockReset();
	getBands.mockResolvedValue({ success: false, error: "unsupported" });
	getUsbModeOptions.mockReset();
	getUsbModeOptions.mockResolvedValue({ certified: [] });
});

afterEach(() => {
	cleanup();
	resetModemsFeed();
	vi.clearAllMocks();
});

describe("the band lock — a read failure speaks, it does not vanish", () => {
	/*
	  THE DEFECT, AT THE SURFACE IT WAS VISIBLE ON. A rejected `getBands` left
	  `bandResult` undefined and the card rendered as `absent`: no control AND no
	  message, which is exactly what a modem with no band support renders.
	*/
	it("a rejected read renders a reason rather than an empty section", async () => {
		getBands.mockRejectedValue(new Error("socket closed"));
		mount(modem());

		const marker = await screen.findByTestId("modem-bands-card-unknown");
		expect(marker.getAttribute("data-state")).toBe("unknown");
		expect(marker.getAttribute("role")).toBe("status");
		expect(marker.textContent).not.toContain("network.modem.");
		expect(marker.textContent?.trim().length ?? 0).toBeGreaterThan(0);

		expect(state("modem-bands-card")).toBe("unknown");
		// CT-4: below `capable` there is no capability to withhold, so there is
		// no control either — not even a disabled one.
		expect(screen.queryAllByTestId("modem-bands-options")).toHaveLength(0);
		expect(screen.queryAllByTestId("modem-bands-card-control")).toHaveLength(0);
	});

	it("a `read_failed` refusal speaks too, with the device's own reason", async () => {
		getBands.mockResolvedValue({ success: false, error: "read_failed" });
		mount(modem());

		await screen.findByTestId("modem-bands-card-unknown");
		expect(state("modem-bands-card")).toBe("unknown");
		expect(expectSpeaks("modem-bands-card-unknown").textContent).toMatch(
			/could not be read/i,
		);
	});

	/*
	  The certification refusal. modem-stack's `band/certification.ts` refuses the
	  WRITE on a SKU whose modem DID advertise bands — a capability that exists
	  and is refused right now, which is `blocked`, not gone.
	*/
	it("an uncertified SKU renders BLOCKED with the certification reason visible", async () => {
		getBands.mockResolvedValue({ success: false, error: "uncertified" });
		mount(modem());

		await waitFor(() => {
			expect(state("modem-bands-card")).toBe("blocked");
		});
		expect(expectSpeaks("modem-bands-card-reason").textContent).toMatch(
			/proven/i,
		);
		// The list is the offer, so a refused one renders no chips at all.
		expect(screen.queryAllByTestId("modem-bands-options")).toHaveLength(0);
		expect(screen.queryByRole("checkbox", { name: /band/i })).toBeNull();
	});

	it("a positively unsupported modem contributes ZERO nodes", async () => {
		getBands.mockResolvedValue({ success: false, error: "unsupported" });
		mount(modem());
		// The section is `unknown` until the read lands, so absence is only a
		// claim about the ANSWER once there is one.
		await waitFor(() => {
			expect(screen.queryAllByTestId("modem-bands-card")).toHaveLength(0);
		});
		expect(screen.queryAllByTestId("modem-bands-card-unknown")).toHaveLength(0);
		expect(screen.queryAllByTestId("modem-bands-card-reason")).toHaveLength(0);
	});

	it("unknown, blocked and absent are three distinguishable renderings", async () => {
		getBands.mockRejectedValue(new Error("socket closed"));
		mount(modem());
		await screen.findByTestId("modem-bands-card-unknown");
		const unknown = state("modem-bands-card");
		cleanup();

		getBands.mockReset();
		getBands.mockResolvedValue({ success: false, error: "uncertified" });
		mount(modem());
		await waitFor(() => expect(state("modem-bands-card")).toBe("blocked"));
		const blocked = state("modem-bands-card");
		cleanup();

		getBands.mockReset();
		getBands.mockResolvedValue({ success: false, error: "unsupported" });
		mount(modem());
		await waitFor(() => {
			expect(screen.queryAllByTestId("modem-bands-card")).toHaveLength(0);
		});

		expect(unknown).not.toBe(blocked);
	});
});

describe("the network-mode selector", () => {
	it("a modem that published no catalog renders a reason and NO control", async () => {
		mount(modem({ network_type: undefined } as Partial<Modem>));
		await screen.findByTestId("modem-advanced-toggle");

		expect(state("modem-network-type")).toBe("unknown");
		expectSpeaks("modem-network-type-unknown");
		expect(screen.queryAllByTestId("modem-network-type-trigger")).toHaveLength(
			0,
		);
	});

	it("a modem that answered with an empty catalog renders ZERO nodes", async () => {
		mount(modem({ network_type: { supported: [], active: null } }));
		await screen.findByTestId("modem-advanced-toggle");

		expect(screen.queryAllByTestId("modem-network-type")).toHaveLength(0);
		expect(screen.queryAllByTestId("modem-network-type-trigger")).toHaveLength(
			0,
		);
	});

	/*
	  The one selector of the three whose offer is a SINGLE control, so `blocked`
	  is CT-2 in full: the control stays on screen, DISABLED, with its reason
	  beside it rather than in a tooltip a kiosk cannot hover to reveal.
	*/
	it("a SIM-less modem renders the control DISABLED beside its reason", async () => {
		mount(modem({ no_sim: true }));
		await screen.findByTestId("modem-advanced-toggle");

		expect(state("modem-network-type")).toBe("blocked");
		const trigger = screen.getByTestId("modem-network-type-trigger");
		expect(
			trigger.hasAttribute("disabled") ||
				trigger.getAttribute("aria-disabled") === "true" ||
				trigger.getAttribute("data-disabled") !== null,
		).toBe(true);
		const reason = expectSpeaks("modem-network-type-reason");
		expect(trigger.getAttribute("aria-describedby")).toBe(reason.id);
	});

	it("a populated catalog with a card in the slot is live", async () => {
		mount(modem());
		await screen.findByTestId("modem-advanced-toggle");

		expect(state("modem-network-type")).toBe("available");
		expect(
			screen.getByTestId("modem-network-type-trigger").hasAttribute("disabled"),
		).toBe(false);
		expect(screen.queryAllByTestId("modem-network-type-unknown")).toHaveLength(
			0,
		);
		expect(screen.queryAllByTestId("modem-network-type-reason")).toHaveLength(
			0,
		);
	});
});

describe("the 5G preference", () => {
	const block = {
		offered: ["prefer-5g", "prefer-4g"],
		active: "prefer-5g",
		nr_mode: { supported: false, reason: "not-exposed-by-modemmanager" },
	};

	it("a modem that advertised no posture renders ZERO nodes", async () => {
		mount(modem({ capability_modules: claims() }));
		await screen.findByTestId("modem-advanced-toggle");

		expect(screen.queryAllByTestId("modem-five-g-card")).toHaveLength(0);
		expect(screen.queryAllByTestId("modem-five-g-options")).toHaveLength(0);
	});

	it.each(["implemented", "enabled"] as const)(
		"the %s claim renders a reason and NO control",
		async (claim) => {
			mount(modem({ capability_modules: claims({ "five-g-pref": claim }) }));
			await screen.findByTestId("modem-advanced-toggle");

			expect(state("modem-five-g-card")).toBe("unknown");
			const marker = expectSpeaks("modem-five-g-card-unknown");
			expect(marker.getAttribute("data-state")).toBe("unknown");
			expect(marker.getAttribute("role")).toBe("status");
			expect(screen.queryAllByTestId("modem-five-g-options")).toHaveLength(0);
		},
	);

	it("a published posture set renders the radiogroup", async () => {
		mount(
			modem({
				capability_modules: claims({ "five-g-pref": "capable" }),
				five_g_preference: block,
			} as Partial<Modem>),
		);
		await screen.findByTestId("modem-advanced-toggle");

		expect(state("modem-five-g-card")).toBe("available");
		expect(screen.getByTestId("modem-five-g-options")).toBeTruthy();
		expect(
			screen
				.getByTestId("modem-five-g-option-prefer-4g")
				.hasAttribute("disabled"),
		).toBe(false);
	});

	it("a SIM-less modem renders the refusal, not the postures", async () => {
		mount(
			modem({
				no_sim: true,
				capability_modules: claims({ "five-g-pref": "capable" }),
				five_g_preference: block,
			} as Partial<Modem>),
		);
		await screen.findByTestId("modem-advanced-toggle");

		expect(state("modem-five-g-card")).toBe("blocked");
		expectSpeaks("modem-five-g-card-reason");
		expect(screen.queryAllByTestId("modem-five-g-options")).toHaveLength(0);
	});
});

describe("the USB-composition offer speaks when it cannot be established", () => {
	it("a rejected options read renders a reason inside the card", async () => {
		getUsbModeOptions.mockRejectedValue(new Error("socket closed"));
		mount(modem({ usb_mode: "qmi", recommended_usb_mode: "mbim" }));

		const marker = await screen.findByTestId("modem-usb-mode-options-unknown");
		expect(marker.getAttribute("role")).toBe("status");
		expect(marker.textContent).not.toContain("network.modem.");
		// The ACTIVE mode is the device's own reading and still renders.
		expect(screen.getByTestId("modem-usb-mode-active")).toBeTruthy();
		expect(screen.queryAllByTestId("modem-usb-mode-targets")).toHaveLength(0);
	});

	it("an answered read carries no such line", async () => {
		getUsbModeOptions.mockResolvedValue({ certified: [] });
		mount(modem({ usb_mode: "qmi", recommended_usb_mode: "mbim" }));
		await screen.findByTestId("modem-usb-mode-active");

		await waitFor(() => {
			expect(
				screen.queryAllByTestId("modem-usb-mode-options-unknown"),
			).toHaveLength(0);
		});
	});
});

describe("the FM350-GL — one combination, no 5G selector, no error", () => {
	it("renders exactly one mode combination", async () => {
		mount(fm350());
		await screen.findByTestId("modem-advanced-toggle");

		expect(state("modem-network-type")).toBe("available");
		expect(
			screen.getByTestId("modem-network-type-trigger").textContent?.trim(),
		).toBe("2G / 3G / 4G / 5G");

		await openNetworkTypeSelect();
		expect(
			document.querySelectorAll('[data-testid^="modem-network-type-option-"]'),
		).toHaveLength(1);
		expect(
			screen.getByTestId("modem-network-type-option-2g3g4g5g"),
		).toBeTruthy();
	});

	it("renders NO 5G selector, because it advertised no posture", async () => {
		mount(fm350());
		await screen.findByTestId("modem-advanced-toggle");

		expect(screen.queryAllByTestId("modem-five-g-card")).toHaveLength(0);
		expect(screen.queryAllByTestId("modem-five-g-options")).toHaveLength(0);
		expect(screen.queryAllByTestId("modem-five-g-card-unknown")).toHaveLength(
			0,
		);
	});

	it("and says nothing is wrong, because nothing is", async () => {
		mount(fm350());
		await screen.findByTestId("modem-advanced-toggle");

		// `CapabilitySection` mounts its outcome band's live regions with the
		// SURFACE rather than with the outcome, so their PRESENCE says nothing —
		// what must hold is that every one of them is empty.
		for (const region of screen.queryAllByRole("alert")) {
			expect(region.textContent?.trim()).toBe("");
		}
		expect(screen.queryAllByTestId("modem-five-g-error")).toHaveLength(0);
		expect(screen.queryAllByTestId("modem-save-refused")).toHaveLength(0);
		expect(screen.queryAllByTestId("modem-network-type-reason")).toHaveLength(
			0,
		);
		expect(screen.queryAllByTestId("modem-bands-card-reason")).toHaveLength(0);
		expect(document.body.textContent).not.toContain("network.modem.");
	});
});
