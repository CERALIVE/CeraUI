import { RELAY_VALIDATE_STAGES } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveStageViews,
	manualSaveEnabled,
	reduceValidateError,
	reduceValidateResult,
	type Validation,
	validationBlocksSave,
} from "$lib/components/streaming/relay-validation";

/**
 * Validate-state reducer (Task 14).
 *
 * The relay endpoint validation walks ordered stages on the backend
 * (input→protocol→endpoint→dns→probe) and returns the first failure, or
 * `{ valid: true, stage: "probe" }` on success. The UI overlays that single
 * result onto the full stage sequence (…→ok) for a multi-stage display, and
 * gates the Save button on the validation state:
 *
 *   • in-flight (validating) → Save DISABLED
 *   • invalid   (fail)       → Save DISABLED
 *   • valid     (pass)       → Save ENABLED (when addr/port are otherwise sound)
 *   • idle                   → Save follows the plain addr/port checks
 *
 * This suite pins the pure, node-testable reducer surface that drives both the
 * Save gate and the stage chips. No runes, no DOM — mirrors the established
 * pure-function test pattern (hud-clock-gating / display-profile).
 */

describe("validationBlocksSave", () => {
	it("blocks while validating (in-flight)", () => {
		expect(validationBlocksSave({ state: "validating" })).toBe(true);
	});

	it("blocks on an invalid (fail) result", () => {
		expect(validationBlocksSave({ state: "fail", stage: "dns" })).toBe(true);
	});

	it("does not block on a passing result", () => {
		expect(validationBlocksSave({ state: "pass", stage: "probe" })).toBe(false);
	});

	it("does not block when idle (never validated)", () => {
		expect(validationBlocksSave({ state: "idle" })).toBe(false);
	});
});

describe("manualSaveEnabled", () => {
	const sound = {
		isStreaming: false,
		addr: "relay.example.com",
		portStr: "5000",
		hasPortError: false,
	};

	it("enables Save on a passing validation with sound addr/port", () => {
		expect(
			manualSaveEnabled({
				...sound,
				validation: { state: "pass", stage: "probe" },
			}),
		).toBe(true);
	});

	it("enables Save when idle but addr/port are sound (validation is advisory)", () => {
		expect(manualSaveEnabled({ ...sound, validation: { state: "idle" } })).toBe(
			true,
		);
	});

	it("disables Save while a validation is in flight", () => {
		expect(
			manualSaveEnabled({ ...sound, validation: { state: "validating" } }),
		).toBe(false);
	});

	it("disables Save on an invalid result even with sound addr/port", () => {
		expect(
			manualSaveEnabled({
				...sound,
				validation: { state: "fail", stage: "probe" },
			}),
		).toBe(false);
	});

	it("disables Save while streaming regardless of validation", () => {
		expect(
			manualSaveEnabled({
				...sound,
				isStreaming: true,
				validation: { state: "pass", stage: "probe" },
			}),
		).toBe(false);
	});

	it("disables Save when the address is empty", () => {
		expect(
			manualSaveEnabled({
				...sound,
				addr: "   ",
				validation: { state: "idle" },
			}),
		).toBe(false);
	});

	it("disables Save when the port is empty", () => {
		expect(
			manualSaveEnabled({
				...sound,
				portStr: "",
				validation: { state: "idle" },
			}),
		).toBe(false);
	});

	it("disables Save when the port is out of range", () => {
		expect(
			manualSaveEnabled({
				...sound,
				hasPortError: true,
				validation: { state: "idle" },
			}),
		).toBe(false);
	});
});

describe("reduceValidateResult", () => {
	it("maps a valid result to a pass state carrying its stage", () => {
		expect(reduceValidateResult({ valid: true, stage: "probe" })).toEqual({
			state: "pass",
			stage: "probe",
		});
	});

	it("maps an invalid result to a fail state with stage + reason", () => {
		expect(
			reduceValidateResult({
				valid: false,
				stage: "dns",
				reason: "no such host",
			}),
		).toEqual({ state: "fail", stage: "dns", reason: "no such host" });
	});
});

describe("reduceValidateError", () => {
	it("maps a thrown Error to a fail at the endpoint stage with its message", () => {
		expect(reduceValidateError(new Error("boom"))).toEqual({
			state: "fail",
			stage: "endpoint",
			reason: "boom",
		});
	});

	it("maps a non-Error throw to a fail at the endpoint stage without a reason", () => {
		expect(reduceValidateError("weird")).toEqual({
			state: "fail",
			stage: "endpoint",
		});
	});
});

describe("deriveStageViews", () => {
	it("covers every schema stage in order", () => {
		const views = deriveStageViews({ state: "idle" });
		expect(views.map((v) => v.stage)).toEqual([...RELAY_VALIDATE_STAGES]);
	});

	it("marks all stages pending when idle", () => {
		const views = deriveStageViews({ state: "idle" });
		expect(views.every((v) => v.status === "pending")).toBe(true);
	});

	it("marks all stages active while validating (in-flight)", () => {
		const views = deriveStageViews({ state: "validating" });
		expect(views.every((v) => v.status === "active")).toBe(true);
	});

	it("marks every stage done on a pass, reaching the terminal ok", () => {
		const views = deriveStageViews({ state: "pass", stage: "probe" });
		expect(views.every((v) => v.status === "done")).toBe(true);
		expect(views.at(-1)).toEqual({ stage: "ok", status: "done" });
	});

	it("marks stages before the failure done, the failing stage failed, the rest pending", () => {
		const views = deriveStageViews({ state: "fail", stage: "dns" });
		const byStage = Object.fromEntries(views.map((v) => [v.stage, v.status]));
		expect(byStage).toEqual({
			input: "done",
			protocol: "done",
			endpoint: "done",
			dns: "failed",
			probe: "pending",
			ok: "pending",
		});
	});

	it("fails the very first stage when input is rejected", () => {
		const views = deriveStageViews({ state: "fail", stage: "input" });
		expect(views[0]).toEqual({ stage: "input", status: "failed" });
		expect(views.slice(1).every((v) => v.status === "pending")).toBe(true);
	});
});

// Type-only guard: Validation must be assignable from each state shape.
const _exhaustive: Validation[] = [
	{ state: "idle" },
	{ state: "validating" },
	{ state: "pass", stage: "probe" },
	{ state: "fail", stage: "dns", reason: "x" },
];
void _exhaustive;
