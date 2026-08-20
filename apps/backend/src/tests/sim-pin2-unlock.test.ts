/*
 * Tests for SIM PIN2 verification — the libqmi path.
 *
 * PIN2 is the one modem credential ModemManager cannot carry: its `Sim` D-Bus
 * interface has no PIN2 method and every backend hardcodes PIN1. So this path
 * runs over `qmicli`, and these tests pin the properties that makes safe:
 *
 *  - the USIM application's PIN2 block is what is read, NOT the first "PIN2
 *    retries" line in the output. The board fixture below is a REAL RM530N-GL
 *    card status in which the ISIM application reports `PIN2 retries: '0'`, so
 *    a flat scan reports a healthy SIM as permanently blocked;
 *  - the QMI device node is DERIVED from ModemManager's own port list, so one
 *    modem's PIN2 can never be submitted against another modem's card;
 *  - the card state is READ before anything is submitted, and a state that
 *    cannot accept a PIN2 never submits one;
 *  - the code is submitted EXACTLY ONCE — PIN2's budget is ~3 and exhausting it
 *    needs a PUK2 the operator very likely does not have;
 *  - the PIN2 never reaches a log line, even though it rides INSIDE the argv
 *    token rather than as a separate one.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import * as execMod from "../helpers/exec.ts";
import { logger } from "../helpers/logger.ts";
import {
	findQmiPort,
	parsePin2CardState,
	pin2PreflightVerdict,
	unlockSimPin2,
} from "../modules/modems/sim-pin2.ts";

afterEach(() => {
	mock.restore();
});

/**
 * VERBATIM `qmicli --uim-get-card-status` output from the bench RM530N-GL
 * (Quectel, IMEI 867978050016855) on 2026-08-16. Two applications, and the
 * SECOND one's PIN2 counters are the trap this fixture exists to reproduce.
 */
const BOARD_CARD_STATUS = `[/dev/cdc-wdm0] Successfully got card status
Provisioning applications:
	Primary GW:   slot '1', application '1'
	Primary 1X:   session doesn't exist
Slot [1]:
	Card state: 'present'
	UPIN state: 'not-initialized'
		UPIN retries: '0'
		UPUK retries: '0'
	Application [1]:
		Application type:  'usim (2)'
		Application state: 'ready'
		Personalization state: 'ready'
		UPIN replaces PIN1: 'no'
		PIN1 state: 'disabled'
			PIN1 retries: '3'
			PUK1 retries: '10'
		PIN2 state: 'enabled-not-verified'
			PIN2 retries: '3'
			PUK2 retries: '10'
	Application [2]:
		Application type:  'isim (5)'
		Application state: 'detected'
		Personalization state: 'unknown'
		UPIN replaces PIN1: 'no'
		PIN1 state: 'disabled'
			PIN1 retries: '3'
			PUK1 retries: '10'
		PIN2 state: 'not-initialized'
			PIN2 retries: '0'
			PUK2 retries: '0'
`;

const BOARD_PORTS = [
	"cdc-wdm0 (qmi)",
	"ttyUSB0 (ignored)",
	"ttyUSB1 (gps)",
	"ttyUSB2 (at)",
	"ttyUSB3 (at)",
	"wwan0 (net)",
];

function cardStatusWith(pin2State: string, pin2Retries: number): string {
	return BOARD_CARD_STATUS.replace(
		"PIN2 state: 'enabled-not-verified'\n\t\t\tPIN2 retries: '3'",
		`PIN2 state: '${pin2State}'\n\t\t\tPIN2 retries: '${pin2Retries}'`,
	);
}

function failure(): execMod.ExecResult & Error {
	return Object.assign(new Error("Command failed"), {
		stdout: "",
		stderr: "error: couldn't verify PIN: IncorrectPin",
		code: 1,
	});
}

/**
 * Stub `execFileP` so the `--uim-verify-pin` submit and the
 * `--uim-get-card-status` reads each draw from their own scripted outcome.
 * Records call order so the read-before-submit and single-submit guarantees are
 * assertable, and records the raw argv so the device-node derivation is too.
 */
function installQmicliMock(opts: {
	statuses?: Array<string | "throw">;
	verify?: "ok" | "throw";
}) {
	const statusQueue = [...(opts.statuses ?? [])];
	const order: Array<"status" | "verify"> = [];
	const argvs: Array<readonly string[]> = [];
	let verifyCalls = 0;

	const impl = async (
		_file: string,
		args: readonly string[] = [],
	): Promise<execMod.ExecResult> => {
		argvs.push(args);
		if (args.some((a) => a.startsWith("--uim-verify-pin="))) {
			order.push("verify");
			verifyCalls += 1;
			if (opts.verify === "throw") {
				throw failure();
			}
			return {
				stdout: "[/dev/cdc-wdm0] PIN verified successfully\n",
				stderr: "",
			};
		}
		order.push("status");
		const next = statusQueue.shift();
		if (next === undefined || next === "throw") {
			throw failure();
		}
		return { stdout: next, stderr: "" };
	};

	const spy = spyOn(execMod, "execFileP").mockImplementation(impl);
	return { spy, order, argvs, getVerifyCalls: () => verifyCalls };
}

describe("parsePin2CardState()", () => {
	it("reads the USIM application's PIN2 block, not the ISIM's", () => {
		const state = parsePin2CardState(BOARD_CARD_STATUS);
		expect(state).toEqual({
			pin2State: "enabled-not-verified",
			pin2Retries: 3,
			puk2Retries: 10,
		});
	});

	it("does not report the ISIM's zero retries for a healthy SIM", () => {
		// The regression this fixture exists for: a flat scan would find the
		// ISIM's `PIN2 retries: '0'` and read a 3-attempt SIM as blocked.
		expect(parsePin2CardState(BOARD_CARD_STATUS)?.pin2Retries).not.toBe(0);
	});

	it("returns undefined when the card exposes no USIM application", () => {
		const isimOnly = BOARD_CARD_STATUS.split("Application [1]:")[0] ?? "";
		expect(parsePin2CardState(isimOnly)).toBeUndefined();
	});

	it("does not throw on truncated or unrelated output", () => {
		expect(parsePin2CardState("")).toBeUndefined();
		expect(parsePin2CardState("error: operation failed")).toBeUndefined();
	});
});

describe("findQmiPort()", () => {
	it("picks the (qmi) control port out of ModemManager's port list", () => {
		expect(findQmiPort(BOARD_PORTS)).toBe("cdc-wdm0");
	});

	it("never adopts an AT / GPS / net port", () => {
		expect(
			findQmiPort(["ttyUSB2 (at)", "ttyUSB1 (gps)", "wwan0 (net)"]),
		).toBeUndefined();
	});

	it("ignores an MBIM control port — it carries no PIN2 route", () => {
		expect(findQmiPort(["cdc-wdm0 (mbim)", "wwan0 (net)"])).toBeUndefined();
	});

	it("resolves a non-zero port index rather than assuming cdc-wdm0", () => {
		expect(findQmiPort(["cdc-wdm2 (qmi)"])).toBe("cdc-wdm2");
	});
});

describe("pin2PreflightVerdict()", () => {
	it("permits a submit only when PIN2 is awaiting verification", () => {
		expect(
			pin2PreflightVerdict({ pin2State: "enabled-not-verified" }),
		).toBeUndefined();
	});

	it("refuses a submit for a blocked PIN2", () => {
		expect(pin2PreflightVerdict({ pin2State: "blocked" })).toEqual({
			state: "puk2-required",
		});
		expect(pin2PreflightVerdict({ pin2State: "permanently-blocked" })).toEqual({
			state: "puk2-required",
		});
	});

	it.each(["disabled", "enabled-verified", "not-initialized"])(
		"reports nothing to unlock for PIN2 state %s",
		(pin2State) => {
			expect(pin2PreflightVerdict({ pin2State })).toEqual({
				state: "no-pin2-lock",
			});
		},
	);
});

describe("unlockSimPin2()", () => {
	it("verifies a correct PIN2 and reports success", async () => {
		const h = installQmicliMock({
			statuses: [BOARD_CARD_STATUS],
			verify: "ok",
		});

		const result = await unlockSimPin2("2", "1111", BOARD_PORTS);

		expect(result).toEqual({ state: "success" });
		expect(h.order).toEqual(["status", "verify"]);
		expect(h.getVerifyCalls()).toBe(1);
	});

	it("derives the QMI device node from the modem's own port list", async () => {
		const h = installQmicliMock({
			statuses: [BOARD_CARD_STATUS],
			verify: "ok",
		});

		await unlockSimPin2("2", "1111", ["cdc-wdm3 (qmi)", "wwan0 (net)"]);

		for (const argv of h.argvs) {
			expect(argv).toContain("/dev/cdc-wdm3");
			expect(argv).not.toContain("/dev/cdc-wdm0");
		}
	});

	it("submits over the QMI proxy so a running ModemManager keeps the port", async () => {
		const h = installQmicliMock({
			statuses: [BOARD_CARD_STATUS],
			verify: "ok",
		});

		await unlockSimPin2("2", "1111", BOARD_PORTS);

		for (const argv of h.argvs) {
			expect(argv).toContain("-p");
		}
	});

	it("addresses PIN2 explicitly — never the bare PIN1 identifier", async () => {
		const h = installQmicliMock({
			statuses: [BOARD_CARD_STATUS],
			verify: "ok",
		});

		await unlockSimPin2("2", "1111", BOARD_PORTS);

		const verifyArgv = h.argvs.find((a) =>
			a.some((t) => t.startsWith("--uim-verify-pin=")),
		);
		expect(verifyArgv?.join(" ")).toContain("--uim-verify-pin=PIN2,1111");
	});

	it("classifies a wrong PIN2 with the remaining attempts and submits ONCE", async () => {
		const h = installQmicliMock({
			statuses: [BOARD_CARD_STATUS, cardStatusWith("enabled-not-verified", 2)],
			verify: "throw",
		});

		const result = await unlockSimPin2("2", "9999", BOARD_PORTS);

		expect(result).toEqual({ state: "wrong-pin2", remainingAttempts: 2 });
		expect(h.getVerifyCalls()).toBe(1);
	});

	it("reports puk2-required when a wrong PIN2 exhausts the budget", async () => {
		const h = installQmicliMock({
			statuses: [BOARD_CARD_STATUS, cardStatusWith("blocked", 0)],
			verify: "throw",
		});

		const result = await unlockSimPin2("2", "9999", BOARD_PORTS);

		expect(result).toEqual({ state: "puk2-required" });
		expect(h.getVerifyCalls()).toBe(1);
	});

	it("refuses to submit against an already-blocked PIN2", async () => {
		const h = installQmicliMock({ statuses: [cardStatusWith("blocked", 0)] });

		const result = await unlockSimPin2("2", "1111", BOARD_PORTS);

		expect(result).toEqual({ state: "puk2-required" });
		expect(h.getVerifyCalls()).toBe(0);
	});

	it("refuses to submit when PIN2 is not awaiting verification", async () => {
		const h = installQmicliMock({
			statuses: [cardStatusWith("enabled-verified", 3)],
		});

		const result = await unlockSimPin2("2", "1111", BOARD_PORTS);

		expect(result).toEqual({ state: "no-pin2-lock" });
		expect(h.getVerifyCalls()).toBe(0);
	});

	it("reports 'unsupported' for a modem with no QMI port, without spawning", async () => {
		const h = installQmicliMock({ statuses: [BOARD_CARD_STATUS] });

		const result = await unlockSimPin2("2", "1111", [
			"cdc-wdm0 (mbim)",
			"wwan0 (net)",
		]);

		expect(result).toEqual({ state: "unsupported" });
		expect(h.spy).not.toHaveBeenCalled();
	});

	it("reports an error when the card state cannot be read at all", async () => {
		const h = installQmicliMock({ statuses: ["throw"] });

		const result = await unlockSimPin2("2", "1111", BOARD_PORTS);

		expect(result).toEqual({ state: "error" });
		expect(h.getVerifyCalls()).toBe(0);
	});

	it.each([
		["bad modem path", "../etc", "1111"],
		["non-numeric pin2", "2", "abcd"],
		["short pin2", "2", "123"],
		["over-long pin2", "2", "123456789"],
		["argv injection in pin2", "2", "1111 --uim-verify-pin=PIN1,0000"],
	])("rejects %s before spawning anything", async (_label, path, pin2) => {
		const h = installQmicliMock({ statuses: [BOARD_CARD_STATUS] });

		const result = await unlockSimPin2(path, pin2, BOARD_PORTS);

		expect(result).toEqual({ state: "error" });
		expect(h.spy).not.toHaveBeenCalled();
	});

	it("never writes the PIN2 to a log line", async () => {
		installQmicliMock({
			statuses: [BOARD_CARD_STATUS, cardStatusWith("enabled-not-verified", 2)],
			verify: "throw",
		});
		const seen: string[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const) {
			spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
				seen.push(args.map((a) => String(a)).join(" "));
			}) as never);
		}

		await unlockSimPin2("2", "4321", BOARD_PORTS);

		expect(seen.join("\n")).not.toContain("4321");
	});
});
