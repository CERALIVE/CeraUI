// @vitest-environment jsdom
/**
 * THE DOM TRUTHFULNESS GATE — `DESIGN.md` §1 CT-1…CT-5 and §3 OL-1/OL-2/OL-3,
 * asserted against the RENDERED result rather than against the rules that
 * produce it.
 *
 * `capability-modules.test.ts` proves the RULE; this proves the markup obeys it.
 * The split matters because every defect this pass removes lived in markup that
 * a correct rule could not save: `{usbModeLabel(mode)}` returned the wire token,
 * and the sub-`capable` claims rendered a reason with no way to tell them apart
 * from a positively-unsupported module.
 *
 * FOUR OPERATION-STATE CLASSES, driven by fixture capability states:
 *
 *   supported-available            → the control renders, enabled.
 *   supported-blocked-with-reason  → the control renders, DISABLED, with an
 *                                    on-screen reason (CT-2).
 *   unsupported-absent             → ZERO nodes for that module (CT-1).
 *   unknown-absent-with-diagnostic → NO control, plus a `role="status"`
 *                                    diagnostic carrying `data-state="unknown"`
 *                                    (CT-3), which is also CT-4: a disabled
 *                                    control below `capable` would be a fake one.
 *
 * The `unknown` class is why the assertions check the ABSENCE of a control and
 * the PRESENCE of a marker rather than just "some text rendered": the retired
 * behaviour rendered text for it too, indistinguishably from the blocked case.
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

import { USB_MODE_RAW_TOKENS } from "$lib/modem/operator-labels";
import {
	publishModems,
	resetModemsFeed,
} from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const getFccUnlock = vi.hoisted(() => vi.fn());
const getGps = vi.hoisted(() => vi.fn());
const getBands = vi.hoisted(() => vi.fn());
const getUsbModeOptions = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			getFccUnlock,
			getGps,
			getBands,
			getUsbModeOptions,
			setFccUnlock: vi.fn(),
			setGps: vi.fn(),
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
		recommended_usb_mode: "mbim",
		...overrides,
	} as Modem;
}

function mount(subject: Modem) {
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
	getGps.mockResolvedValue({
		success: true,
		status: { gnssEnabled: false },
		state: { kind: "off" },
	});
	getBands.mockResolvedValue({ success: false, error: "unsupported" });
	getUsbModeOptions.mockResolvedValue({ certified: [] });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// Each gated module names its section, its control, its blocked reason, and its
// unknown diagnostic — so one table drives both modules through all four states.
const MODULES = [
	{
		module: "gps" as const,
		section: "modem-gps",
		control: "modem-gps-toggle",
		reason: "modem-gps-reason",
		unknown: "modem-gps-unknown",
		/** Drives the ≥capable-but-refused case for this module. */
		refuse: () => getGps.mockResolvedValue({ success: false }),
	},
	{
		module: "fcc-auto-unlock" as const,
		section: "modem-fcc-unlock",
		control: "modem-fcc-unlock-toggle",
		reason: "modem-fcc-unlock-reason",
		unknown: "modem-fcc-unlock-unknown",
		refuse: () =>
			getFccUnlock.mockResolvedValue({
				success: true,
				state: {
					key: "2c7c:0801",
					coverage: "absent",
					enabled: false,
					model_wide: true,
					requires_reprobe: true,
				},
			}),
	},
];

describe.each(MODULES)(
	"$module — the four operation-state classes",
	({ module, section, control, reason, unknown, refuse }) => {
		// CT-1. Queried by test id and expected to count ZERO — not hidden, not
		// aria-disabled, not a tooltip. Nothing.
		it("unsupported-absent: contributes ZERO DOM nodes", async () => {
			mount(modem({ capability_modules: claims({ [module]: "unavailable" }) }));
			await screen.findByTestId("modem-advanced-toggle");

			expect(screen.queryAllByTestId(section)).toHaveLength(0);
			expect(screen.queryAllByTestId(control)).toHaveLength(0);
			expect(screen.queryAllByTestId(reason)).toHaveLength(0);
			expect(screen.queryAllByTestId(unknown)).toHaveLength(0);
		});

		it("unsupported-absent: an ABSENT matrix fails closed the same way", async () => {
			mount(modem({ capability_modules: undefined }));
			await screen.findByTestId("modem-advanced-toggle");
			expect(screen.queryAllByTestId(section)).toHaveLength(0);
		});

		// CT-3 + CT-4. The gate is off, so nothing has been established about this
		// modem — and a disabled control would claim there is something to enable.
		it.each(["implemented", "enabled"] as const)(
			"unknown-absent-with-diagnostic: the %s claim renders a distinct diagnostic and NO control",
			async (claim) => {
				mount(modem({ capability_modules: claims({ [module]: claim }) }));

				const marker = await screen.findByTestId(unknown);
				expect(marker.getAttribute("data-state")).toBe("unknown");
				expect(marker.getAttribute("role")).toBe("status");
				expect(marker.textContent?.trim().length).toBeGreaterThan(0);
				expect(marker.textContent).not.toContain("network.modem.");

				expect(screen.queryAllByTestId(control)).toHaveLength(0);
				expect(
					screen.getByTestId(section).getAttribute("data-capability-state"),
				).toBe("unknown");
			},
		);

		// CT-2. Supported, refused right now: present, disabled, reason on screen.
		it("supported-blocked-with-reason: renders a DISABLED control beside a non-empty reason", async () => {
			refuse();
			mount(modem({ capability_modules: claims({ [module]: "capable" }) }));

			const toggle = await screen.findByTestId(control);
			expect(
				toggle.hasAttribute("disabled") ||
					toggle.getAttribute("aria-disabled") === "true" ||
					toggle.getAttribute("data-disabled") !== null,
			).toBe(true);

			const line = screen.getByTestId(reason);
			expect(line.textContent?.trim().length).toBeGreaterThan(0);
			expect(line.textContent).not.toContain("network.modem.");
			expect(line.textContent).not.toContain("undefined");
			expect(
				screen.getByTestId(section).getAttribute("data-capability-state"),
			).toBe("blocked");
		});

		// CT-3's "distinguishable from BOTH" clause, asserted directly: the marker
		// attribute of the unknown rendering must differ from the blocked one.
		it("unknown is distinguishable from blocked, not merely worded differently", async () => {
			refuse();
			mount(modem({ capability_modules: claims({ [module]: "capable" }) }));
			await screen.findByTestId(control);
			const blocked = screen
				.getByTestId(section)
				.getAttribute("data-capability-state");
			cleanup();

			mount(modem({ capability_modules: claims({ [module]: "enabled" }) }));
			await screen.findByTestId(unknown);
			const unknownState = screen
				.getByTestId(section)
				.getAttribute("data-capability-state");

			expect(unknownState).not.toBe(blocked);
		});

		it.each(["capable", "certified"] as const)(
			"supported-available: the %s claim renders an ENABLED control",
			async (claim) => {
				mount(modem({ capability_modules: claims({ [module]: claim }) }));

				const toggle = await screen.findByTestId(control);
				expect(toggle.hasAttribute("disabled")).toBe(false);
				expect(toggle.getAttribute("aria-disabled")).not.toBe("true");
				expect(
					screen.getByTestId(section).getAttribute("data-capability-state"),
				).toBe("available");
				expect(screen.queryAllByTestId(unknown)).toHaveLength(0);
			},
		);

		// CT-5. Re-rendering with the SAME unknown evidence must not flip to the
		// unsupported (hidden) rendering — the degradation this rule exists for.
		it("CT-5: two renders with the same unknown evidence keep the same DOM shape", async () => {
			const subject = modem({
				capability_modules: claims({ [module]: "enabled" }),
			});
			mount(subject);
			const first = (await screen.findByTestId(unknown)).outerHTML;
			cleanup();

			mount(subject);
			expect((await screen.findByTestId(unknown)).outerHTML).toBe(first);
		});
	},
);

describe("OL-1/OL-2/OL-3 — no raw wire token outside a marked diagnostics block", () => {
	/** Text an operator can read, with every diagnostics subtree removed. */
	function operatorText(): string {
		const root = document.body.cloneNode(true) as HTMLElement;
		for (const node of root.querySelectorAll('[data-testid*="diagnostic"]')) {
			node.remove();
		}
		return root.textContent ?? "";
	}

	beforeEach(() => {
		getBands.mockResolvedValue({
			success: true,
			bands: {
				supported: ["eutran-3", "ngran-78", "xyzzy-9"],
				current: ["eutran-3"],
				offerable: ["eutran-3", "ngran-78", "xyzzy-9"],
				unlocked: false,
			},
		});
		getUsbModeOptions.mockResolvedValue({ certified: ["mbim", "ecm-ncm"] });
	});

	it("OL-1: the active composition reads as a behaviour, and the token is only an attribute", async () => {
		mount(modem());
		const active = await screen.findByTestId("modem-usb-mode-active");

		expect(active.getAttribute("data-usb-mode")).toBe("rndis");
		expect(active.textContent?.trim().length).toBeGreaterThan(0);
		for (const token of USB_MODE_RAW_TOKENS) {
			expect(active.textContent?.toLowerCase()).not.toContain(token);
		}
	});

	it("OL-1: no composition token appears anywhere an operator reads", async () => {
		mount(modem());
		await screen.findByTestId("modem-usb-mode-targets");

		const text = operatorText().toLowerCase();
		for (const token of USB_MODE_RAW_TOKENS) {
			expect(text).not.toContain(token);
		}
	});

	it("OL-2: band chips and the locked-to line carry no wire token", async () => {
		mount(modem());
		await screen.findByTestId("modem-bands-card");

		const chip = screen.getByTestId("modem-band-option-eutran-3");
		expect(chip.getAttribute("data-band")).toBe("eutran-3");
		expect(chip.textContent).not.toContain("eutran");

		const text = operatorText().toLowerCase();
		for (const token of ["eutran-3", "ngran-78", "xyzzy-9"]) {
			expect(text).not.toContain(token);
		}
	});

	// OL-5: a token this build cannot name resolves to honest generic copy AND a
	// pointer — generic copy alone would be a dead end.
	it("OL-5: an unmapped band gets generic copy plus the diagnostics pointer", async () => {
		mount(modem());
		await screen.findByTestId("modem-bands-card");

		expect(
			screen.getByTestId("modem-band-option-xyzzy-9").textContent,
		).not.toContain("xyzzy");
		expect(screen.getByTestId("modem-bands-unmapped-hint")).toBeTruthy();
	});

	// OL-3: RELOCATED, not deleted. The values a field engineer needs are still
	// there, verbatim, in the block that says what it is.
	it("OL-3: every suppressed token is still readable in the diagnostics block", async () => {
		mount(modem());
		const block = await screen.findByTestId("modem-raw-diagnostics");

		expect(screen.getByTestId("modem-raw-usb-mode").textContent).toBe("rndis");
		expect(block.textContent).toContain("eutran-3");
		expect(block.textContent).toContain("ngran-78");
		expect(block.textContent).toContain("xyzzy-9");
	});

	// NON-VACUITY: the scrubber must actually be removing something, or the
	// operator-text assertions above pass because the tokens were never rendered.
	it("the diagnostics scrubber is what makes the operator-text scan meaningful", async () => {
		mount(modem());
		await screen.findByTestId("modem-raw-diagnostics");

		expect(document.body.textContent).toContain("eutran-3");
		expect(operatorText()).not.toContain("eutran-3");
	});

	// OL-4: the block is marked AND collapsed — it lives inside the Advanced
	// disclosure, which opens closed on every open.
	it("OL-4: the diagnostics block is marked as such and starts collapsed", async () => {
		mount(modem());
		await screen.findByTestId("modem-raw-diagnostics");

		const toggle = screen.getByTestId("modem-advanced-toggle");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(
			screen
				.getByTestId("modem-raw-diagnostics")
				.closest('[data-testid="modem-advanced-body"]'),
		).not.toBeNull();
	});

	it("absence renders as absence: nothing to relocate means no diagnostics block", async () => {
		getBands.mockResolvedValue({ success: false, error: "unsupported" });
		mount(
			modem({
				usb_mode: undefined,
				recommended_usb_mode: undefined,
				cell_info: undefined,
			}),
		);
		await screen.findByTestId("modem-advanced-toggle");

		expect(screen.queryAllByTestId("modem-raw-diagnostics")).toHaveLength(0);
	});
});
