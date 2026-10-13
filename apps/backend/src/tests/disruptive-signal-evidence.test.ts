import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	isDisruptiveActionPending,
	PowerSubmissionError,
} from "../modules/system/disruptive-action-reservation.ts";
import { setDisruptiveRetryClockForTest } from "../modules/system/disruptive-retry.ts";
import { withServiceReservation } from "../modules/system/disruptive-service-reservation.ts";
import { submitPowerCommand } from "../modules/system/power-submission.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { sysextFixture } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let fixture: ReturnType<typeof sysextFixture>;
let wakeups: Array<() => Promise<void>>;
beforeEach(() => {
	fixture = sysextFixture();
	wakeups = [];
	setDisruptiveRetryClockForTest({
		schedule: (run) => {
			wakeups.push(run);
			return () => undefined;
		},
	});
});
afterEach(() => {
	setDisruptiveRetryClockForTest(null);
	fixture.reset();
});

for (const [code, signalCode, expectedHeld] of [
	[1, null, false],
	[2, null, false],
	[126, null, false],
	[127, null, false],
	[128, null, true],
	[129, null, true],
	[137, null, true],
	[143, null, true],
	[255, null, true],
	[1, "SIGKILL", true],
	[2, "SIGTERM", true],
	[137, "SIGKILL", true],
	[143, "SIGTERM", true],
	["ENOENT", null, false],
	["EACCES", null, false],
	["ENOEXEC", null, false],
	["E2BIG", null, false],
] as const) {
	test(`service exit ${code}/${signalCode} retains=${expectedHeld} until positive evidence`, async () => {
		// Given a real reservation and a client error with literal exit/signal evidence.
		const failure = Object.assign(new Error("client failed"), {
			code,
			signalCode,
		});
		let completed = false;
		let probes = 0;
		// When the service resolver sees the client outcome followed by unknown evidence.
		const error = await withServiceReservation(
			async () => {
				throw failure;
			},
			{ unit: "example.service", decision: () => ({ allowed: true }) },
			async () => {
				probes++;
				return completed ? "completed" : "unknown";
			},
		).catch((caught: unknown) => caught);
		// Then only ordinary positive failures release without observing retirement.
		expect(error).toBe(failure);
		expect(isDisruptiveActionPending()).toBe(expectedHeld);
		expect(probes).toBe(expectedHeld ? 1 : 0);
		if (expectedHeld) {
			const wake = wakeups.shift();
			if (!wake) throw new Error("missing observation wakeup");
			await wake();
			expect(isDisruptiveActionPending()).toBe(true);
			completed = true;
			const final = wakeups.shift();
			if (!final) throw new Error("missing final wakeup");
			await final();
			expect(isDisruptiveActionPending()).toBe(false);
		}
	});
}

for (const [exitCode, expectedHeld] of [
	[1, false],
	[127, false],
	[137, true],
	[143, true],
	[null, true],
] as const) {
	test(`power exit ${exitCode} retains shutdown=${expectedHeld}`, () => {
		// Given a power runner whose native exit is not a shutdown verdict.
		const failure = new PowerSubmissionError("reboot", exitCode);
		// When the real power submission classifies it.
		const result = submitPowerCommand("reboot", () => {
			throw failure;
		});
		// Then signal-derived or unavailable exit evidence cannot open a launch window.
		expect(result).toEqual({ success: false, error: failure.message });
		expect(isDisruptiveActionPending()).toBe(expectedHeld);
	});
}
