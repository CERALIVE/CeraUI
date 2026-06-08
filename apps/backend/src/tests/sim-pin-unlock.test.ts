/*
 * Tests for Task 22: SIM PIN unlock — backend mmcli integration.
 *
 * Properties under test:
 *  - a correct PIN unlocks a locked modem to a bondable state ("success");
 *  - a wrong PIN returns a typed "wrong-pin" with the remaining attempt count
 *    read back from mmcli, and the PIN is submitted EXACTLY ONCE (never retried
 *    blindly toward a PUK lockout);
 *  - the lock state is READ before the PIN is submitted (the registration race
 *    the RPC exists to close);
 *  - PUK / already-unlocked / mmcli-failure states are classified correctly and
 *    never submit a PIN they can't use;
 *  - the PIN never appears in any log line (redacted to ***).
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import * as execMod from "../helpers/exec.ts";
import { logger } from "../helpers/logger.ts";
import {
	MODEM_PATH_RE,
	parseModemUnlockInfo,
	unlockSimPin,
} from "../modules/modems/mmcli.ts";

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
 * Stub `execFileP` so the `--pin` submit and the `-K -m` lock reads each draw
 * from their own scripted outcome. Records call order so tests can assert the
 * read-before-submit ordering and the single-submit guarantee.
 */
function installMmcliMock(opts: {
	locks?: Array<string | "throw">;
	pin?: "ok" | "throw";
}) {
	const lockQueue = [...(opts.locks ?? [])];
	const order: Array<"lock" | "pin"> = [];
	let pinCalls = 0;
	let lockCalls = 0;

	const impl = async (
		_file: string,
		args: readonly string[] = [],
	): Promise<execMod.ExecResult> => {
		if (args.includes("--pin")) {
			order.push("pin");
			pinCalls += 1;
			if (opts.pin === "throw") {
				throw failure();
			}
			return {
				stdout: "successfully sent PIN code to the modem\n",
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
		getPinCalls: () => pinCalls,
		getLockCalls: () => lockCalls,
	};
}

describe("parseModemUnlockInfo()", () => {
	it("reads the required lock and per-kind remaining attempts", () => {
		const info = parseModemUnlockInfo({
			"modem.generic.unlock-required": "sim-pin",
			"modem.generic.unlock-retries": ["sim-pin (3)", "sim-puk (10)"],
		});
		expect(info.required).toBe("sim-pin");
		expect(info.retries).toEqual({ "sim-pin": 3, "sim-puk": 10 });
	});

	it("reports 'none' when the SIM is already unlocked", () => {
		const info = parseModemUnlockInfo({
			"modem.generic.unlock-required": "none",
		});
		expect(info.required).toBe("none");
		expect(info.retries).toEqual({});
	});

	it("collapses an unknown / missing lock token to 'unknown'", () => {
		expect(parseModemUnlockInfo({}).required).toBe("unknown");
		expect(
			parseModemUnlockInfo({
				"modem.generic.unlock-required": "sim-net-pin",
			}).required,
		).toBe("unknown");
	});

	it("ignores a malformed unlock-retries entry without throwing", () => {
		const info = parseModemUnlockInfo({
			"modem.generic.unlock-required": "sim-pin",
			"modem.generic.unlock-retries": ["garbage"],
		});
		expect(info.retries).toEqual({});
	});
});

describe("MODEM_PATH_RE", () => {
	it("accepts a bare index and a ModemManager DBus path", () => {
		expect(MODEM_PATH_RE.test("0")).toBe(true);
		expect(MODEM_PATH_RE.test("12")).toBe(true);
		expect(MODEM_PATH_RE.test("/org/freedesktop/ModemManager1/Modem/3")).toBe(
			true,
		);
	});

	it("rejects flag-like and injection payloads", () => {
		expect(MODEM_PATH_RE.test("-m")).toBe(false);
		expect(MODEM_PATH_RE.test("0; reboot")).toBe(false);
		expect(MODEM_PATH_RE.test("")).toBe(false);
		expect(MODEM_PATH_RE.test("../0")).toBe(false);
	});
});

describe("unlockSimPin()", () => {
	it("unlocks a PIN-locked modem with the correct PIN", async () => {
		const m = installMmcliMock({
			locks: [lockOutput("sim-pin", { "sim-pin": 3 })],
			pin: "ok",
		});

		const result = await unlockSimPin("0", "1234");

		expect(result).toEqual({ state: "success" });
		// Lock state is READ before the PIN is submitted (race closed).
		expect(m.order).toEqual(["lock", "pin"]);
		expect(m.getPinCalls()).toBe(1);
	});

	it("returns wrong-pin with remaining attempts and submits the PIN once", async () => {
		const m = installMmcliMock({
			locks: [
				lockOutput("sim-pin", { "sim-pin": 3 }),
				lockOutput("sim-pin", { "sim-pin": 2 }),
			],
			pin: "throw",
		});

		const result = await unlockSimPin("0", "9999");

		expect(result).toEqual({ state: "wrong-pin", remainingAttempts: 2 });
		// Submitted exactly once — never retried toward a PUK lockout.
		expect(m.getPinCalls()).toBe(1);
		// Re-read the lock state after the rejection to learn attempts left.
		expect(m.getLockCalls()).toBe(2);
	});

	it("surfaces puk-required when a wrong PIN exhausts the attempts", async () => {
		const m = installMmcliMock({
			locks: [
				lockOutput("sim-pin", { "sim-pin": 1 }),
				lockOutput("sim-puk", { "sim-puk": 10 }),
			],
			pin: "throw",
		});

		const result = await unlockSimPin("0", "9999");

		expect(result).toEqual({ state: "puk-required" });
		expect(m.getPinCalls()).toBe(1);
	});

	it("reports puk-required up front without submitting a PIN", async () => {
		const m = installMmcliMock({
			locks: [lockOutput("sim-puk", { "sim-puk": 10 })],
		});

		const result = await unlockSimPin("0", "1234");

		expect(result).toEqual({ state: "puk-required" });
		expect(m.getPinCalls()).toBe(0);
	});

	it("reports no-locked-modem when nothing is pending and never submits", async () => {
		const m = installMmcliMock({ locks: [lockOutput("none")] });

		const result = await unlockSimPin("0", "1234");

		expect(result).toEqual({ state: "no-locked-modem" });
		expect(m.getPinCalls()).toBe(0);
	});

	it("returns error when the lock-state read fails", async () => {
		const m = installMmcliMock({ locks: ["throw"] });

		const result = await unlockSimPin("0", "1234");

		expect(result).toEqual({ state: "error" });
		expect(m.getPinCalls()).toBe(0);
	});

	it("rejects an invalid modem path / PIN before touching mmcli", async () => {
		const m = installMmcliMock({ locks: [lockOutput("sim-pin")] });

		expect(await unlockSimPin("0; reboot", "1234")).toEqual({
			state: "error",
		});
		expect(await unlockSimPin("0", "12")).toEqual({ state: "error" });

		expect(m.spy).not.toHaveBeenCalled();
	});

	it("never writes the PIN to any log line", async () => {
		const pin = "4321";
		const logged: string[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const) {
			spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
				return logger;
			}) as never);
		}

		installMmcliMock({
			locks: [
				lockOutput("sim-pin", { "sim-pin": 3 }),
				lockOutput("sim-pin", { "sim-pin": 2 }),
			],
			pin: "throw",
		});

		const result = await unlockSimPin("0", pin);

		expect(result.state).toBe("wrong-pin");
		expect(logged.some((line) => line.includes(pin))).toBe(false);
		// run()'s redactArgs masks the PIN argv token to *** in the debug log.
		expect(logged.some((line) => line.includes("***"))).toBe(true);
	});
});
