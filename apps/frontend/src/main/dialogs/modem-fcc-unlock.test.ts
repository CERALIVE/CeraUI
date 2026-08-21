import type { FccUnlockState } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { fccUnlockErrorKey, fccUnlockView } from "./modem-fcc-unlock";

function state(overrides: Partial<FccUnlockState> = {}): FccUnlockState {
	return {
		key: "2c7c:0801",
		coverage: "present",
		enabled: false,
		model_wide: true,
		requires_reprobe: true,
		...overrides,
	};
}

describe("fccUnlockView", () => {
	it("Given a module this build or this modem cannot do, When resolved, Then NOTHING renders", () => {
		expect(fccUnlockView("unavailable", state()).kind).toBe("absent");
		expect(fccUnlockView(undefined, state()).kind).toBe("absent");
	});

	// `implemented`/`enabled` are BELOW the `capable` floor, so nothing has been
	// established about this modem. DESIGN.md CT-4 forbids a disabled control
	// there — a disabled control implies a capability being withheld — so they
	// resolve to the `unknown` diagnostic, which is visibly distinct from BOTH
	// the offered and the absent renderings (CT-3) and keeps its own reason.
	it("Given the device gate is off, When resolved, Then it is UNKNOWN with the gate reason", () => {
		expect(fccUnlockView("implemented", state())).toEqual({
			kind: "unknown",
			reasonKey: "network.modem.fccUnlock.reason.moduleDisabled",
		});
	});

	it("Given the gate is on but the coverage read failed, When resolved, Then it is unknown as unproven", () => {
		expect(fccUnlockView("enabled", undefined)).toEqual({
			kind: "unknown",
			reasonKey: "network.modem.fccUnlock.reason.unproven",
		});
	});

	// A state with no key has nothing to name a symlink after — but the claim is
	// already ≥ capable, so this is the DEVICE refusing right now, which is the
	// disabled-with-reason class (CT-2) rather than a withheld one.
	it("Given a capable claim with no device key, When resolved, Then the control is BLOCKED with a reason", () => {
		expect(fccUnlockView("capable", state({ key: undefined }))).toEqual({
			kind: "blocked",
			reasonKey: "network.modem.fccUnlock.reason.unproven",
		});
	});

	it("Given a capable claim on an uncovered model, When resolved, Then it says so rather than offering a toggle", () => {
		expect(fccUnlockView("capable", state({ coverage: "absent" }))).toEqual({
			kind: "blocked",
			reasonKey: "network.modem.fccUnlock.reason.notCovered",
		});
	});

	it.each(["capable", "certified"] as const)(
		"Given a %s claim on a covered model, When resolved, Then the toggle renders with its model key",
		(claim) => {
			expect(fccUnlockView(claim, state({ enabled: true }))).toEqual({
				kind: "toggle",
				enabled: true,
				key: "2c7c:0801",
			});
		},
	);

	// CT-5: an unknown state must not degrade into a hidden one on a re-render.
	it("Given the same unknown evidence twice, When resolved, Then the view is identical", () => {
		expect(fccUnlockView("enabled", undefined)).toEqual(
			fccUnlockView("enabled", undefined),
		);
	});
});

describe("fccUnlockErrorKey", () => {
	it.each([
		"not_covered",
		"identity_unknown",
		"streaming_active",
		"module_disabled",
		"mutation_blocked",
	])(
		"Given the known token %s, When keyed, Then it maps to its own copy",
		(token) => {
			expect(fccUnlockErrorKey(token)).toBe(
				`network.modem.fccUnlock.error.${token}`,
			);
		},
	);

	// A raw machine token must never reach operator copy, so an unmapped one falls
	// back rather than being interpolated into a key nothing translates.
	it("Given a token this build does not know, When keyed, Then it falls back to the generic failure", () => {
		expect(fccUnlockErrorKey("some_future_reason")).toBe(
			"network.modem.fccUnlock.error.write_failed",
		);
	});
});
