/**
 * Unit tests for sim-unlock-outcome.ts
 *
 * The classifiers are the SIM-unlock confirm/transition signal. These cases lock
 * every terminal the dialog must distinguish — success unlocks, wrong-pin/puk
 * surface an inline error, puk-required hands off to the PUK sub-form, locked is
 * a terminal lockout, no-locked-modem closes the dialog, and any unknown state
 * degrades to a generic error.
 */

import type { SimPukUnlockOutput, SimUnlockOutput } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	classifySimPinResult,
	classifySimPukResult,
} from "./sim-unlock-outcome";

describe("classifySimPinResult", () => {
	it("classifies success as ok", () => {
		expect(classifySimPinResult({ state: "success" })).toEqual({ ok: true });
	});

	it("classifies wrong-pin as a non-ok inline error", () => {
		expect(
			classifySimPinResult({ state: "wrong-pin", remainingAttempts: 2 }),
		).toEqual({ ok: false, reason: "wrong-pin" });
	});

	it("classifies puk-required as the PUK hand-off reason", () => {
		expect(classifySimPinResult({ state: "puk-required" })).toEqual({
			ok: false,
			reason: "puk-required",
		});
	});

	it("classifies no-locked-modem as the close reason", () => {
		expect(classifySimPinResult({ state: "no-locked-modem" })).toEqual({
			ok: false,
			reason: "no-locked-modem",
		});
	});

	it("degrades an error state to a generic error", () => {
		expect(classifySimPinResult({ state: "error" })).toEqual({
			ok: false,
			reason: "error",
		});
	});

	it("degrades an unknown state to a generic error", () => {
		expect(
			classifySimPinResult({
				state: "totally-unknown",
			} as unknown as SimUnlockOutput),
		).toEqual({ ok: false, reason: "error" });
	});
});

describe("classifySimPukResult", () => {
	it("classifies success as ok", () => {
		expect(classifySimPukResult({ success: true })).toEqual({ ok: true });
	});

	it("classifies wrong-puk as a non-ok inline error", () => {
		expect(
			classifySimPukResult({
				success: false,
				error: "wrong-puk",
				remainingAttempts: 9,
			}),
		).toEqual({ ok: false, reason: "wrong-puk" });
	});

	it("classifies locked as the terminal lockout reason", () => {
		expect(
			classifySimPukResult({ success: false, error: "locked", remainingAttempts: 0 }),
		).toEqual({ ok: false, reason: "locked" });
	});

	it("classifies no-locked-modem as the close reason", () => {
		expect(
			classifySimPukResult({ success: false, error: "no-locked-modem" }),
		).toEqual({ ok: false, reason: "no-locked-modem" });
	});

	it("degrades an error to a generic error", () => {
		expect(classifySimPukResult({ success: false, error: "error" })).toEqual({
			ok: false,
			reason: "error",
		});
	});

	it("degrades a missing error to a generic error", () => {
		expect(
			classifySimPukResult({
				success: false,
			} as unknown as SimPukUnlockOutput),
		).toEqual({ ok: false, reason: "error" });
	});
});
