// @vitest-environment jsdom
/**
 * THE GUARANTEED MINIMUM BASELINE, as a rendered card.
 *
 * `derive.test.ts` proves the MODEL; this proves the card an operator actually
 * gets. The subject is the case the whole directory exists for: a device this
 * build does not recognise — no provider match, no capabilities, the barest
 * telemetry the wire allows — which must still produce
 *
 *   1. an identity,
 *   2. whatever telemetry is readable and nothing more, and
 *   3. an explicit statement that it is unavailable, WITH a reason,
 *
 * with zero thrown errors and no empty frame anywhere in it.
 *
 * The structural-identity leg is the other half of "one rendering path": a
 * recognised device and an unrecognised one must produce the SAME set of blocks
 * in the SAME order, differing only in what each block was told.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import SectionsHarness from "./__fixtures__/SectionsHarness.svelte";
import { BASELINE_UNAVAILABLE_KEY, deriveModemSections } from "./derive";

function modem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "",
		network_type: { supported: [], active: null },
		...overrides,
	} as Modem;
}

/** No provider match, no capabilities, minimal telemetry. */
const UNRECOGNIZED = modem({ ifname: "wwan9" });

/** A device the build understands completely, for the structural comparison. */
const RECOGNIZED = modem({
	ifname: "wwan0",
	name: "RM530N-GL",
	slot_label: "Slot 1",
	device_class: "usb",
	no_sim: false,
	firmware_revision: "RM530NGLAAR01A05M4G",
	status: {
		connection: "connected",
		network_type: "5g",
		signal: 86,
		roaming: false,
		network: "Movistar",
	},
} as Partial<Modem>);

function mount(device: Modem) {
	return render(SectionsHarness, {
		props: { sections: deriveModemSections({ modem: device }) },
	});
}

describe("an unrecognized device still gets a complete card", () => {
	it("renders without throwing", () => {
		expect(() => mount(UNRECOGNIZED)).not.toThrow();
	});

	it("renders every block — no block collapses to nothing", () => {
		const { getByTestId } = mount(UNRECOGNIZED);

		for (const block of [
			"modem-identity",
			"modem-connection",
			"modem-signal",
			"modem-sim",
			"modem-diagnostics",
		]) {
			expect(getByTestId(block).textContent?.trim().length).toBeGreaterThan(0);
		}
	});

	it("leg 1 — identity is on screen, and says the device named itself nothing", () => {
		const { getByTestId } = mount(UNRECOGNIZED);

		expect(getByTestId("modem-identity-title").textContent?.trim()).toBe(
			"wwan9",
		);
		expect(getByTestId("modem-identity").getAttribute("data-identified")).toBe(
			"false",
		);
		expect(
			getByTestId("modem-identity-unnamed").textContent?.trim().length,
		).toBeGreaterThan(0);
	});

	it("leg 2 — an unreadable signal is stated in words, with no meter and no zero", () => {
		const { getByTestId, queryByTestId } = mount(UNRECOGNIZED);
		const unreadable = getByTestId("modem-signal-unreadable");

		expect(unreadable.getAttribute("role")).toBe("status");
		expect(unreadable.textContent?.trim().length).toBeGreaterThan(0);
		expect(queryByTestId("modem-signal-reading")).toBeNull();
		// No stand-in mark anywhere in the block.
		expect(getByTestId("modem-signal").textContent).not.toMatch(
			/[—–-]{1,2}\s*$/,
		);
	});

	it("leg 3 — an explicit unavailability statement, with a reason", () => {
		const { getByTestId } = mount(UNRECOGNIZED);
		const note = getByTestId("modem-unavailability-baseline");

		expect(note.getAttribute("data-reason-key")).toBe(BASELINE_UNAVAILABLE_KEY);
		expect(note.textContent?.trim().length).toBeGreaterThan(0);
		// A dotted key rendered raw is the failure this assertion exists for.
		expect(note.textContent).not.toContain(BASELINE_UNAVAILABLE_KEY);
	});

	it("claims no SIM it was never told about", () => {
		const { getByTestId, queryByTestId } = mount(UNRECOGNIZED);

		expect(getByTestId("modem-sim").getAttribute("data-sim-presence")).toBe(
			"unknown",
		);
		expect(queryByTestId("modem-sim-present")).toBeNull();
		expect(queryByTestId("modem-sim-absent")).toBeNull();
	});

	it("renders no dotted i18n key anywhere on the card", () => {
		const { getByTestId } = mount(UNRECOGNIZED);

		expect(getByTestId("harness-card").textContent ?? "").not.toMatch(
			/\bnetwork\.[a-z][A-Za-z]*\./,
		);
	});
});

describe("recognised and unrecognised render the SAME structure", () => {
	const BLOCKS = [
		"modem-identity",
		"modem-connection",
		"modem-signal",
		"modem-sim",
		"modem-diagnostics",
	] as const;

	function blockOrder(container: HTMLElement): string[] {
		return [...container.querySelectorAll("[data-testid]")]
			.map((el) => el.getAttribute("data-testid") ?? "")
			.filter((id): id is (typeof BLOCKS)[number] =>
				(BLOCKS as readonly string[]).includes(id),
			);
	}

	it("produces the same blocks in the same order", () => {
		const unknownCard = mount(UNRECOGNIZED);
		const knownCard = mount(RECOGNIZED);

		expect(blockOrder(unknownCard.container)).toEqual([...BLOCKS]);
		expect(blockOrder(knownCard.container)).toEqual([...BLOCKS]);
	});

	it("differs only in what each block was told", () => {
		const { getByTestId } = mount(RECOGNIZED);

		expect(getByTestId("modem-identity").getAttribute("data-identified")).toBe(
			"true",
		);
		expect(
			getByTestId("modem-signal-reading").getAttribute("data-signal-tier"),
		).toBe("high");
		expect(getByTestId("modem-sim").getAttribute("data-sim-presence")).toBe(
			"present",
		);
		expect(
			getByTestId("modem-connection").getAttribute("data-connection-state"),
		).toBe("connected");
	});

	/*
	  A recognised, working device has already explained itself, so the baseline
	  floor must NOT fire for it. A floor that always fires is decoration.
	*/
	it("does not band a working device with the baseline statement", () => {
		const { queryByTestId } = mount(RECOGNIZED);

		expect(queryByTestId("modem-unavailability-baseline")).toBeNull();
	});
});

describe("a diagnostics block with nothing to show says so", () => {
	it("renders a sentence rather than an empty frame", () => {
		const { getByTestId } = render(SectionsHarness, {
			props: {
				sections: {
					...deriveModemSections({ modem: UNRECOGNIZED }),
					diagnostics: { rows: [] },
				},
			},
		});

		expect(
			getByTestId("modem-diagnostics-empty").textContent?.trim().length,
		).toBeGreaterThan(0);
	});
});
