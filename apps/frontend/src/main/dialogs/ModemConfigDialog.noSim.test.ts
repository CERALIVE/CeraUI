// @vitest-environment jsdom
/**
 * ONE NO-SIM PREDICATE, SHARED BY THE ROW AND THE DIALOG.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT DIVERGED, AND WHY EACH HALF WAS WRONG
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The Cellular row asks `isSimlessModem` (`main/network/cellular-row.ts`), which
 * delegates to `@ceraui/rpc`'s `isSimlessForBond` — the SAME rule the device's
 * own bond gate applies. This dialog carried a second, hand-rolled copy:
 *
 *     modem.no_sim === true || modem.status?.signal == null
 *
 * Both halves of that were wrong, in opposite directions.
 *
 * The MISSING half is `router_admin.sim`, the only field a `router-ethernet`
 * dongle reports its slot through, so this surface could not see a SIM-less
 * dongle at all — the exact asymmetry the shared rule exists to close.
 *
 * The EXTRA half is worse, because it is the one an operator meets: a signal
 * reading is a fact about the RADIO, not about the slot. A modem holding a
 * perfectly good SIM that has not reported a signal yet — one searching, or one
 * the network refused, which is precisely when an APN is worth checking — had
 * its entire configuration form disabled, including the APN field that is the
 * reason this dialog exists. It also drew the shared "No SIM" tag over a
 * populated slot, so the dialog contradicted the row behind it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A table comparing rendered output against `isSimlessModem` proves the two
 * AGREE today. It does not prove they are the same function — a faithful second
 * copy would pass it and then drift on the next change to either side. So the
 * delegation is proven separately by forcing the row's predicate to answer
 * against the wire fields and asserting the dialog follows IT: a private copy
 * cannot, because it never asks. The static gate then proves no copy is left.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Modem } from "@ceraui/rpc/schemas";
import { render, screen } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetModemsFeed } from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const simless = vi.hoisted(() => vi.fn<(modem: Modem) => boolean>());

// The spy WRAPS the real module rather than replacing it: every other export
// (`resolveRowState`, the reason tables…) must keep working, and the default
// implementation below is the genuine predicate, so the parity table exercises
// production behaviour rather than a fixture's idea of it.
vi.mock("../network/cellular-row", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../network/cellular-row")>();
	return {
		...actual,
		isSimlessModem: (modem: Modem) => simless(modem),
	};
});

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
		getIsConnected: () => true,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

/** The REAL predicate, for the parity table and for the spy's default. */
let realIsSimlessModem: (modem: Modem) => boolean;

function open(modem: Modem) {
	return render(ModemConfigDialog, {
		props: { open: true, modem, deviceId: "0" },
	});
}

function bannerRendered(): boolean {
	return screen.queryByTestId("modem-no-sim-banner") !== null;
}

/** The fieldset every configuration control lives in. */
function configFieldset(): HTMLFieldSetElement {
	const fieldset = document.querySelector("fieldset");
	if (fieldset === null) throw new Error("the config fieldset never rendered");
	return fieldset as HTMLFieldSetElement;
}

// ── Fixtures: one per class, one per SIM verdict ─────────────────────────────

/** A directly-managed radio with no card in the slot. */
function mmManagedNoSim(): Modem {
	return {
		ifname: "wwan0",
		name: "SIMCOM_SIM7600G-H",
		network_type: { supported: ["4g"], active: null },
		device_class: "usb",
		no_sim: true,
	} as Modem;
}

/**
 * A SIM-BEARING modem that has not reported a signal. THE regression case: the
 * retired copy called this SIM-less and disabled the whole form.
 */
function mmManagedSearching(): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		device_class: "usb",
		no_sim: false,
		status: { connection: "scanning", network_type: "", roaming: false },
		config: { apn: "", autoconfig: true, roaming: false },
	} as Modem;
}

/** The same modem before its first `status` frame has arrived at all. */
function mmManagedNoStatus(): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		network_type: { supported: ["4g"], active: "4g" },
		device_class: "usb",
		config: { apn: "internet", autoconfig: false, roaming: false },
	} as Modem;
}

/** A router-mode dongle reporting its slot through its OWN admin API. */
function dongle(sim: "absent" | "present" | "unknown"): Modem {
	return {
		ifname: "enx344b50000000",
		name: "ZTE MF79U",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.0.1",
			reachable: true,
			sim,
			connection: "disconnected",
		},
	} as Modem;
}

beforeAll(async () => {
	const actual = await vi.importActual<
		typeof import("../network/cellular-row")
	>("../network/cellular-row");
	realIsSimlessModem = actual.isSimlessModem;

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
	resetModemsFeed();
	simless.mockReset();
	simless.mockImplementation((modem) => realIsSimlessModem(modem));
});

describe("the dialog asks the ROW's predicate — it does not answer for itself", () => {
	it("hands the modem it was given to `isSimlessModem`", () => {
		const modem = mmManagedSearching();
		open(modem);

		expect(simless).toHaveBeenCalled();
		expect(simless).toHaveBeenCalledWith(modem);
	});

	/*
	  The falsifiability pair. Each fixture's WIRE FIELDS say the opposite of what
	  the predicate is forced to answer, so only a dialog that really delegates
	  can follow it — a second copy reading `no_sim`/`router_admin.sim` itself
	  would render the wire's answer and fail.
	*/
	it("shows the banner and disables the form when the shared rule says SIM-less", () => {
		simless.mockReturnValue(true);
		// A modem whose own fields are unambiguously SIM-BEARING.
		open({
			...mmManagedSearching(),
			no_sim: false,
			status: { connection: "connected", network_type: "5g", signal: 72 },
		} as Modem);

		expect(bannerRendered()).toBe(true);
		expect(configFieldset().disabled).toBe(true);
	});

	it("shows no banner and leaves the form live when the shared rule says otherwise", () => {
		simless.mockReturnValue(false);
		// A modem whose own field is unambiguously SIM-LESS.
		open(mmManagedNoSim());

		expect(bannerRendered()).toBe(false);
		expect(configFieldset().disabled).toBe(false);
	});
});

describe("dialog and row agree on every class and every SIM verdict", () => {
	const CASES: readonly { name: string; modem: () => Modem }[] = [
		{ name: "mm-managed, empty slot", modem: mmManagedNoSim },
		{ name: "mm-managed, SIM in, no signal yet", modem: mmManagedSearching },
		{ name: "mm-managed, no status frame yet", modem: mmManagedNoStatus },
		{ name: "dongle, admin API says absent", modem: () => dongle("absent") },
		{ name: "dongle, admin API says present", modem: () => dongle("present") },
		{ name: "dongle, admin API unjustifiable", modem: () => dongle("unknown") },
	];

	it.each(CASES)("$name", ({ modem }) => {
		const subject = modem();
		open(subject);

		// The row's answer, computed independently of the render.
		expect(bannerRendered()).toBe(realIsSimlessModem(subject));
		expect(configFieldset().disabled).toBe(realIsSimlessModem(subject));
	});

	/*
	  The retired copy's exact defect, pinned so it cannot come back: a SIM the
	  device positively reported as present, with no signal reading beside it,
	  must leave the operator able to change the APN.
	*/
	it("keeps the APN reachable on a SIM-bearing modem with no signal", () => {
		open(mmManagedSearching());

		expect(bannerRendered()).toBe(false);
		expect(configFieldset().disabled).toBe(false);
	});

	/*
	  And the half that was missing entirely: this surface could not see a
	  dongle's slot at all, because it never read `router_admin.sim`.
	*/
	it("sees a SIM-less dongle, which the retired copy could not", () => {
		open(dongle("absent"));

		expect(bannerRendered()).toBe(true);
	});
});

describe("there is no second copy of the predicate left in the dialog", () => {
	const SOURCE = readFileSync(
		path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"ModemConfigDialog.svelte",
		),
		"utf8",
	);

	/** Executable text only — this file's own prose may name the retired shape. */
	function stripComments(source: string): string {
		return source
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
	}

	const EXECUTABLE = stripComments(SOURCE);

	it("derives `noSim` from the shared predicate", () => {
		expect(EXECUTABLE).toContain("isSimlessModem(modem)");
	});

	it("reads neither SIM wire field itself", () => {
		// `no_sim` and `router_admin.sim` are the shared rule's inputs. READING
		// either here is, by definition, a second implementation of it — so the
		// match is on a PROPERTY ACCESS, not on the token. The quoted `'no_sim'`
		// that still appears is a `LinkVisualState` connection-state VALUE handed
		// to `LinkIndicator`; it consumes the verdict rather than deriving one.
		expect(EXECUTABLE).not.toMatch(/\.no_sim\b/);
		expect(EXECUTABLE).not.toMatch(/router_admin\??\.sim\b/);
	});

	it("does not infer a SIM verdict from a signal reading", () => {
		expect(EXECUTABLE).not.toMatch(/status\??\.signal\s*==/);
	});

	it("the comment stripper is not vacuous", () => {
		// If it silently returned nothing, every assertion above would pass.
		expect(EXECUTABLE.length).toBeGreaterThan(SOURCE.length / 2);
		expect(EXECUTABLE).toContain("const noSim");
		// …and it really does remove prose, which is what lets this file's own
		// header name the retired shape.
		expect(SOURCE).toMatch(/no_sim/);
	});
});
