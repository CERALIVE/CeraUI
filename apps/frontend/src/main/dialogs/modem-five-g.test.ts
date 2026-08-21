import type { Modem, ModemFiveGPreference } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { fiveGFailureKey, fiveGView, fiveGViewForModem } from "./modem-five-g";

const NR_MODE = {
	supported: false,
	reason: "not-exposed-by-modemmanager",
} as const;

const block = (
	overrides: Partial<ModemFiveGPreference> = {},
): ModemFiveGPreference => ({
	offered: ["5g-only", "prefer-5g", "prefer-4g", "5g-off"],
	active: "prefer-5g",
	nr_mode: NR_MODE,
	...overrides,
});

const modemWith = (five: ModemFiveGPreference | undefined): Modem =>
	({
		ifname: "wwan0",
		name: "QUECTEL Broadband Module",
		network_type: { supported: [], active: "5g4g3g2g" },
		...(five === undefined ? {} : { five_g_preference: five }),
	}) as Modem;

describe("capability-gated visibility", () => {
	it("renders NOTHING when the device published no block", () => {
		// Fail-CLOSED: absence of a claim is not a claim, and offering a
		// radio-mutating control to a device that never described itself is the
		// outcome the capability framework exists to prevent.
		expect(fiveGView(undefined)).toEqual({ kind: "hidden" });
		expect(fiveGViewForModem(modemWith(undefined))).toEqual({ kind: "hidden" });
		expect(fiveGViewForModem(undefined)).toEqual({ kind: "hidden" });
	});

	it("renders NOTHING for a published block that advertises no posture", () => {
		// One impossible option is worse than no control at all.
		expect(fiveGView(block({ offered: [], active: null }))).toEqual({
			kind: "hidden",
		});
	});

	it("renders exactly the postures the DEVICE offered, in its order", () => {
		const view = fiveGView(block({ offered: ["prefer-5g", "5g-off"] }));
		expect(view.kind).toBe("offered");
		if (view.kind !== "offered") return;
		expect(view.options.map((option) => option.preference)).toEqual([
			"prefer-5g",
			"5g-off",
		]);
	});

	it("never re-derives the gate — a hidden module cannot be reached by any input", () => {
		// The only thing that opens the control is the device publishing a
		// non-empty block. There is deliberately no claims/gate argument here.
		expect(fiveGView(undefined).kind).toBe("hidden");
	});
});

describe("the active posture", () => {
	it("marks exactly the posture the radio is on", () => {
		const view = fiveGView(block({ active: "prefer-4g" }));
		if (view.kind !== "offered") throw new Error("expected an offered view");
		expect(view.options.filter((option) => option.active)).toHaveLength(1);
		expect(view.options.find((option) => option.active)?.preference).toBe(
			"prefer-4g",
		);
	});

	it("marks NOTHING when the radio sits on a pair no posture names", () => {
		// `null` is first-class and must not be rounded to the nearest posture:
		// that would show an operator a selection they never made.
		const view = fiveGView(block({ active: null }));
		if (view.kind !== "offered") throw new Error("expected an offered view");
		expect(view.options.some((option) => option.active)).toBe(false);
		expect(view.active).toBeNull();
	});

	it("distinguishes the two postures that share an allowed set", () => {
		const five = fiveGView(block({ active: "prefer-5g" }));
		const four = fiveGView(block({ active: "prefer-4g" }));
		if (five.kind !== "offered" || four.kind !== "offered") {
			throw new Error("expected offered views");
		}
		expect(five.active).not.toBe(four.active);
	});

	it("every option carries its own label and description key", () => {
		const view = fiveGView(block());
		if (view.kind !== "offered") throw new Error("expected an offered view");
		const keys = view.options.flatMap((option) => [
			option.labelKey,
			option.descriptionKey,
		]);
		expect(new Set(keys).size).toBe(keys.length);
		for (const key of keys) expect(key).toMatch(/^network\.modem\.fiveG\./);
	});
});

describe("SA / NSA is stated, never omitted", () => {
	it("always carries a reason key", () => {
		const view = fiveGView(block());
		if (view.kind !== "offered") throw new Error("expected an offered view");
		expect(view.nrModeReasonKey).toBe("network.modem.fiveG.nrMode.notExposed");
	});
});

describe("failure copy", () => {
	it("keys every typed device failure to its own sentence", () => {
		const errors = [
			"unknown_modem",
			"not_offered",
			"write_failed",
			"readback_mismatch",
			"readback_failed",
		] as const;
		const keys = errors.map(fiveGFailureKey);
		expect(new Set(keys).size).toBe(errors.length);
		// The two readback arms are DIFFERENT facts: one means the radio landed
		// elsewhere, the other that nothing can be claimed about where it landed.
		expect(fiveGFailureKey("readback_mismatch")).not.toBe(
			fiveGFailureKey("readback_failed"),
		);
	});

	it("falls back to a generic sentence rather than rendering a raw token", () => {
		expect(fiveGFailureKey(undefined)).toBe(
			"network.modem.fiveG.error.generic",
		);
		expect(fiveGFailureKey("module_disabled")).toBe(
			"network.modem.fiveG.error.generic",
		);
	});

	it("never returns a raw machine token as copy", () => {
		for (const token of ["write_failed", "nope", undefined]) {
			expect(fiveGFailureKey(token)).toMatch(/^network\.modem\.fiveG\.error\./);
		}
	});
});
