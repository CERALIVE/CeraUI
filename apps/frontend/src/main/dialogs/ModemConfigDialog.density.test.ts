// @vitest-environment jsdom
/**
 * ModemConfigDialog — the todo-64 primary/secondary split.
 *
 * Measured on the bench board at the 1024x600 kiosk viewport, this dialog's
 * body was 783px of content in a 363px window: four read-only instrument panels
 * stood between the operator and the Save button for the APN they came to
 * change. The fix is information architecture only — one "Advanced" disclosure,
 * nothing removed — so this file pins WHICH side of it each block landed on.
 *
 * The reachability half is the one that must not rot. Every card that moved is
 * asserted PRESENT inside the disclosure body by ancestry, because a dialog
 * that quietly stopped rendering the USB-composition switch would look exactly
 * like a successful decluttering until someone needed it.
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

const connected = vi.hoisted(() => ({ value: true }));

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			setUsbMode: vi.fn(),
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
		getIsConnected: () => connected.value,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

/** A modem carrying every additive Phase-B field, so no card is absent. */
function fullModem(): Modem {
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
		stable_key: "platform-xhci-hcd.0-usb-1:2",
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
		data_usage_policy: { supported: true, cycle_day: 17 },
		config: { apn: "", autoconfig: true, roaming: false },
	} as Modem;
}

function open(modem: Modem = fullModem()) {
	return render(ModemConfigDialog, {
		props: { open: true, modem, deviceId: "0" },
	});
}

function advancedBody(): HTMLElement {
	return screen.getByTestId("modem-advanced-body");
}

/** `inert` is read as the PROPERTY: jsdom implements it but never reflects it
 * back to an attribute, so `hasAttribute` is permanently false here. */
function isInert(el: HTMLElement): boolean {
	return (el as HTMLElement & { inert?: boolean }).inert === true;
}

function inAdvanced(testid: string): boolean {
	const el = screen.queryByTestId(testid);
	return el !== null && advancedBody().contains(el);
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
	connected.value = true;
	resetModemsFeed();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("the primary surface is the settings the operator came for", () => {
	it("keeps every toggle — roaming, Automatic APN — outside the disclosure", () => {
		open();
		const body = advancedBody();
		const switches = [
			...document.querySelectorAll<HTMLElement>("[data-slot='switch']"),
		];
		expect(switches.length).toBeGreaterThan(0);
		for (const control of switches) {
			expect(
				body.contains(control),
				`${control.getAttribute("aria-label")} must stay on the primary surface`,
			).toBe(false);
		}
	});

	it("keeps the status strip and the save action outside the disclosure", () => {
		open();
		const body = advancedBody();
		const heading = screen.getAllByText("Quectel RM520N-GL")[0];

		expect(heading).toBeTruthy();
		expect(body.contains(heading as Node)).toBe(false);
	});
});

describe("the Advanced disclosure holds every secondary block, and loses none", () => {
	it("files the four instrument cards", () => {
		open();
		for (const testid of [
			"modem-usage-card",
			"modem-detail-card",
			"modem-sms-card",
			"modem-usb-mode-card",
		]) {
			expect(
				screen.queryByTestId(testid),
				`${testid} must still render`,
			).not.toBeNull();
			expect(inAdvanced(testid), `${testid} must be inside Advanced`).toBe(
				true,
			);
		}
	});

	/*
	  RETARGETED — the assertion is inverted BY DECISION, not weakened.

	  This test used to pin network type INSIDE Advanced, on the theory that a
	  radio-technology lock is a set-once-per-site decision. Operators reported
	  otherwise: pinning a modem to 4G where 5G is marginal is routine field work,
	  and it was the only thing in that disclosure an operator ever came to
	  CHANGE — everything else down there is a read-only instrument or device
	  surgery. It is now primary, and this pins it there so it cannot drift back.
	*/
	it("promotes the network-type lock OUT of Advanced", () => {
		open();
		const networkType = screen.getByTestId("modem-network-type");

		expect(advancedBody().contains(networkType)).toBe(false);
	});

	it("keeps it reachable without expanding anything", () => {
		open();
		const trigger = screen.getByTestId("modem-network-type-trigger");

		// `inert` is what makes the collapsed body unreachable to a keyboard, so
		// "outside every inert ancestor" IS the reachability claim — presence in
		// the DOM alone is not. Walked as a PROPERTY: jsdom implements `inert` but
		// never reflects it to an attribute, so a `[inert]` selector is vacuous.
		let node: HTMLElement | null = trigger;
		while (node) {
			expect(node.inert).not.toBe(true);
			node = node.parentElement;
		}
		expect(advancedBody().contains(trigger)).toBe(false);
	});

	it("files the usage-policy controls, still writable", () => {
		open();
		expect(inAdvanced("modem-usage-policy")).toBe(true);
		expect(
			screen
				.getByTestId("modem-usage-cycle-day-select")
				.hasAttribute("disabled"),
		).toBe(false);
		expect(
			screen
				.getByTestId("modem-usage-threshold-input")
				.hasAttribute("disabled"),
		).toBe(false);
	});

	it("keeps the SMS card's OWN fold — the outer disclosure does not replace it", () => {
		open();
		const card = screen.getByTestId("modem-sms-card");
		const toggle = screen.getByTestId("modem-sms-toggle");

		expect(advancedBody().contains(card)).toBe(true);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		// The inner fold is `{#if}`-gated, so a collapsed inbox holds no message
		// text in the DOM at all. That is a privacy property, not a visual one.
		expect(screen.queryByTestId("modem-sms-list")).toBeNull();
		expect(screen.queryByTestId("modem-sms-refresh")).toBeNull();
	});
});

describe("the Advanced disclosure is a real disclosure", () => {
	it("starts collapsed and inert, and expands on its labelled trigger", async () => {
		open();
		const toggle = screen.getByTestId("modem-advanced-toggle");

		expect(advancedBody().dataset.open).toBe("false");
		expect(isInert(advancedBody())).toBe(true);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.getAttribute("aria-controls")).toBe(advancedBody().id);
		expect(toggle.textContent?.trim()).toBeTruthy();

		await fireEvent.click(toggle);

		expect(advancedBody().dataset.open).toBe("true");
		expect(isInert(advancedBody())).toBe(false);
		expect(
			screen.getByTestId("modem-advanced-toggle").getAttribute("aria-expanded"),
		).toBe("true");
	});

	it("names what is inside so the operator can tell it was moved, not deleted", () => {
		open();
		const toggle = screen.getByTestId("modem-advanced-toggle");
		const text = toggle.textContent ?? "";

		expect(text).toContain("Advanced");
		expect(text.length).toBeGreaterThan("Advanced".length);
	});

	it("carries the 44px touch target", () => {
		open();
		expect(screen.getByTestId("modem-advanced-toggle").className).toContain(
			"min-h-[44px]",
		);
	});

	/*
	  …AND WHILE COLLAPSED IT IS WITHDRAWN FROM HIT TESTING.

	  `inert` (above) covers focus and the accessibility tree. It does NOT cover
	  the pointer: `overflow: hidden` clips painting only, so every control down
	  here keeps a full-size layout box at its uncollapsed coordinates and a
	  pointer-driven caller is told it is reachable. The Cellular row measured
	  exactly that on the board and fixed it on its own copy of this markup;
	  `CollapsibleSection` carries the same guard now, and this pins that the
	  DIALOG'S disclosure really gets it. The escaping BOX is a browser fact —
	  jsdom lays nothing out — so it is proven in
	  `tests/e2e/modem-advanced-disclosure.spec.ts`.
	*/
	it("hides the collapsed body from the pointer, not only from focus", async () => {
		open();
		const clip = advancedBody().firstElementChild;
		if (!(clip instanceof HTMLElement)) throw new Error("no clipping wrapper");

		expect(clip.style.visibility).toBe("hidden");

		await fireEvent.click(screen.getByTestId("modem-advanced-toggle"));
		expect(clip.style.visibility).toBe("visible");
	});
});
