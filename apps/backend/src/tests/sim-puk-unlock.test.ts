/*
 * Tests for the SIM PUK recovery flow — backend mmcli integration.
 *
 * Properties under test:
 *  - a correct PUK + new PIN recovers a PUK-locked modem ("success");
 *  - a wrong PUK returns "wrong-puk" with the remaining PUK attempt count read
 *    back from mmcli, and the PUK is submitted EXACTLY ONCE (never retried);
 *  - when the remaining PUK attempts reach 0 the SIM is reported "locked";
 *  - the lock state is READ before the PUK is submitted;
 *  - already-unlocked / PIN-only / mmcli-failure states are classified without
 *    submitting a PUK they can't use;
 *  - neither the PUK nor the new PIN appears in any log line (redacted to ***).
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import * as execMod from "../helpers/exec.ts";
import { logger } from "../helpers/logger.ts";
import { unlockSimPuk } from "../modules/modems/mmcli.ts";

afterEach(() => {
	mock.restore();
});

function lockOutput(
	required: string,
	retries?: Record<string, number>,
): string {
	const lines = [`modem.generic.unlock-required: ${required}`];
	const entries = Object.entries(retries ?? {});
	if (entries.length > 0) {
		lines.push(`modem.generic.unlock-retries.length: ${entries.length}`);
		entries.forEach(([kind, count], idx) => {
			lines.push(
				`modem.generic.unlock-retries.value[${idx}]: ${kind} (${count})`,
			);
		});
	}
	return lines.join("\n");
}

function failure(): execMod.ExecResult & Error {
	return Object.assign(new Error("Command failed"), {
		stdout: "",
		stderr: "GDBus...IncorrectPassword",
		code: 1,
	});
}

/**
 * Stub `execFileP` so the `--puk` submit and the `-K -m` lock reads each draw
 * from their own scripted outcome. The submit is detected by the `--puk` token
 * (mmSendSimPuk passes `--puk <puk> --pin <newpin>`).
 */
function installMmcliMock(opts: {
	locks?: Array<string | "throw">;
	puk?: "ok" | "throw";
}) {
	const lockQueue = [...(opts.locks ?? [])];
	const order: Array<"lock" | "puk"> = [];
	let pukCalls = 0;
	let lockCalls = 0;

	const impl = async (
		_file: string,
		args: readonly string[] = [],
	): Promise<execMod.ExecResult> => {
		if (args.includes("--puk")) {
			order.push("puk");
			pukCalls += 1;
			if (opts.puk === "throw") {
				throw failure();
			}
			return {
				stdout: "successfully sent PUK and PIN code to the modem\n",
				stderr: "",
			};
		}
		order.push("lock");
		lockCalls += 1;
		const next = lockQueue.shift();
		if (next === undefined || next === "throw") {
			throw failure();
		}
		return { stdout: next, stderr: "" };
	};

	const spy = spyOn(execMod, "execFileP").mockImplementation(impl);
	return {
		spy,
		order,
		getPukCalls: () => pukCalls,
		getLockCalls: () => lockCalls,
	};
}

describe("unlockSimPuk()", () => {
	it("recovers a PUK-locked modem with the correct PUK + new PIN", async () => {
		const m = installMmcliMock({
			locks: [lockOutput("sim-puk", { "sim-puk": 10 })],
			puk: "ok",
		});

		const result = await unlockSimPuk("0", "12345678", "1234");

		expect(result).toEqual({ success: true });
		// Lock state is READ before the PUK is submitted.
		expect(m.order).toEqual(["lock", "puk"]);
		expect(m.getPukCalls()).toBe(1);
	});

	it("returns wrong-puk with decremented attempts and submits the PUK once", async () => {
		const m = installMmcliMock({
			locks: [
				lockOutput("sim-puk", { "sim-puk": 10 }),
				lockOutput("sim-puk", { "sim-puk": 9 }),
			],
			puk: "throw",
		});

		const result = await unlockSimPuk("0", "00000000", "1234");

		expect(result).toEqual({
			success: false,
			error: "wrong-puk",
			remainingAttempts: 9,
		});
		// Submitted exactly once — never retried toward a permanent lockout.
		expect(m.getPukCalls()).toBe(1);
		// Re-read the lock state after the rejection to learn attempts left.
		expect(m.getLockCalls()).toBe(2);
	});

	it("reports locked when the remaining PUK attempts reach zero", async () => {
		const m = installMmcliMock({
			locks: [
				lockOutput("sim-puk", { "sim-puk": 1 }),
				lockOutput("sim-puk", { "sim-puk": 0 }),
			],
			puk: "throw",
		});

		const result = await unlockSimPuk("0", "00000000", "1234");

		expect(result).toEqual({
			success: false,
			error: "locked",
			remainingAttempts: 0,
		});
		expect(m.getPukCalls()).toBe(1);
	});

	it("recovers a PUK2-locked modem the same way", async () => {
		installMmcliMock({
			locks: [lockOutput("sim-puk2", { "sim-puk2": 10 })],
			puk: "ok",
		});

		const result = await unlockSimPuk("0", "87654321", "4321");

		expect(result).toEqual({ success: true });
	});

	it("reports no-locked-modem when no PUK is pending and never submits", async () => {
		const m = installMmcliMock({
			locks: [lockOutput("sim-pin", { "sim-pin": 3 })],
		});

		const result = await unlockSimPuk("0", "12345678", "1234");

		expect(result).toEqual({ success: false, error: "no-locked-modem" });
		expect(m.getPukCalls()).toBe(0);
	});

	it("returns error when the lock-state read fails", async () => {
		const m = installMmcliMock({ locks: ["throw"] });

		const result = await unlockSimPuk("0", "12345678", "1234");

		expect(result).toEqual({ success: false, error: "error" });
		expect(m.getPukCalls()).toBe(0);
	});

	it("rejects an invalid modem path / PUK / PIN before touching mmcli", async () => {
		const m = installMmcliMock({ locks: [lockOutput("sim-puk")] });

		expect(await unlockSimPuk("0; reboot", "12345678", "1234")).toEqual({
			success: false,
			error: "error",
		});
		// PUK must be exactly 8 digits.
		expect(await unlockSimPuk("0", "1234567", "1234")).toEqual({
			success: false,
			error: "error",
		});
		// New PIN must be 4-8 digits.
		expect(await unlockSimPuk("0", "12345678", "12")).toEqual({
			success: false,
			error: "error",
		});

		expect(m.spy).not.toHaveBeenCalled();
	});

	it("never writes the PUK or the new PIN to any log line", async () => {
		const puk = "13572468";
		const newPin = "9182";
		const logged: string[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const) {
			spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
				return logger;
			}) as never);
		}

		installMmcliMock({
			locks: [
				lockOutput("sim-puk", { "sim-puk": 10 }),
				lockOutput("sim-puk", { "sim-puk": 9 }),
			],
			puk: "throw",
		});

		const result = await unlockSimPuk("0", puk, newPin);

		expect(result.success).toBe(false);
		expect(logged.some((line) => line.includes(puk))).toBe(false);
		expect(logged.some((line) => line.includes(newPin))).toBe(false);
		// run()'s redactArgs masks both secret argv tokens to *** in the debug log.
		expect(logged.some((line) => line.includes("***"))).toBe(true);
	});
});
