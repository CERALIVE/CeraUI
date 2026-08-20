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
	it("Given a module this build or this modem cannot do, When resolved, Then the section is HIDDEN", () => {
		expect(fccUnlockView("unavailable", state()).kind).toBe("hidden");
		expect(fccUnlockView(undefined, state()).kind).toBe("hidden");
	});

	// `implemented` means the gate is OFF and turning it on is the fix, so the
	// control has to be visible — the same distinction `module_disabled` vs
	// `module_unavailable` draws on the write side.
	it("Given the device gate is off, When resolved, Then it is BLOCKED with the gate reason", () => {
		expect(fccUnlockView("implemented", state())).toEqual({
			kind: "blocked",
			reasonKey: "network.modem.fccUnlock.reason.moduleDisabled",
		});
	});

	it("Given the gate is on but the coverage read failed, When resolved, Then it is blocked as unproven", () => {
		expect(fccUnlockView("enabled", undefined)).toEqual({
			kind: "blocked",
			reasonKey: "network.modem.fccUnlock.reason.unproven",
		});
	});

	// A state with no key has nothing to name a symlink after, so there is nothing
	// a toggle could act on even though the claim says `capable`.
	it("Given a capable claim with no device key, When resolved, Then no toggle is offered", () => {
		expect(fccUnlockView("capable", state({ key: undefined })).kind).toBe(
			"blocked",
		);
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
