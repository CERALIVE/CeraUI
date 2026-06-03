/*
 * Tests for Task 14: mmcli.ts migrated onto the argv-only run() runner plus
 * mode-string validation. The security properties under test:
 *  - allowed/preferred mode strings are validated against VALID_MODES before
 *    they become `--set-allowed-modes` / `--set-preferred-mode` flag values;
 *  - argument injection ("--help; rm -rf /") is rejected and never reaches exec;
 *  - the shouldMockModems() guard still short-circuits BEFORE run() touches the
 *    real OS.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import * as execMod from "../helpers/exec.ts";
import {
	initMockService,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	mmList,
	mmSetNetworkTypes,
	VALID_MODES,
	validateModeSpec,
} from "../modules/modems/mmcli.ts";

afterEach(() => {
	mock.restore();
	stopMockService();
});

describe("validateModeSpec() — mode allowlist", () => {
	it("accepts single ModemManager mode tokens", () => {
		for (const v of ["any", "2g", "3g", "4g", "5g", "none"]) {
			expect(validateModeSpec(v)).toBe(v);
		}
	});

	it("accepts a pipe-joined allowed-modes combination", () => {
		expect(validateModeSpec("4g|5g")).toBe("4g|5g");
		expect(validateModeSpec("2g|3g|4g")).toBe("2g|3g|4g");
	});

	it("rejects argument injection outright", () => {
		expect(() => validateModeSpec("--help; rm -rf /")).toThrow(
			"invalid mode: --help; rm -rf /",
		);
		expect(() => validateModeSpec("5g; reboot")).toThrow("invalid mode");
		expect(() => validateModeSpec("4g|--set-allowed-modes")).toThrow(
			"invalid mode",
		);
		expect(() => validateModeSpec("lte")).toThrow("invalid mode: lte");
	});

	it("exposes the expected canonical token set", () => {
		expect([...VALID_MODES].sort()).toEqual([
			"2g",
			"3g",
			"4g",
			"5g",
			"any",
			"none",
		]);
	});
});

describe("mmSetNetworkTypes() — validation gates the exec", () => {
	it("builds argv via run() for a valid allowed/preferred pair", async () => {
		const spy = spyOn(execMod, "execFileP").mockResolvedValue({
			stdout: "successfully set current modes in the modem\n",
			stderr: "",
		} as never);

		await mmSetNetworkTypes(0, "4g|5g", "5g");

		expect(spy).toHaveBeenCalledTimes(1);
		const [, args] = spy.mock.calls[0] as [string, string[], unknown];
		expect(args).toContain("--set-allowed-modes=4g|5g");
		expect(args).toContain("--set-preferred-mode=5g");
	});

	it("omits --set-preferred-mode when preferred is 'none'", async () => {
		const spy = spyOn(execMod, "execFileP").mockResolvedValue({
			stdout: "successfully set current modes in the modem\n",
			stderr: "",
		} as never);

		await mmSetNetworkTypes(0, "4g", "none");

		const [, args] = spy.mock.calls[0] as [string, string[], unknown];
		expect(args).toContain("--set-allowed-modes=4g");
		expect(args.some((a) => a.startsWith("--set-preferred-mode"))).toBe(false);
	});

	it("rejects an injected mode string before any exec runs", async () => {
		const spy = spyOn(execMod, "execFileP").mockResolvedValue({
			stdout: "",
			stderr: "",
		} as never);

		const result = await mmSetNetworkTypes(0, "--help; rm -rf /", "none");

		expect(result).toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("mmList() — shouldMockModems() guard stays before run()", () => {
	it("returns the mocked single-modem list without invoking exec", async () => {
		const spy = spyOn(execMod, "execFileP").mockResolvedValue({
			stdout: "",
			stderr: "",
		} as never);

		process.env.MOCK_MODE = "true";
		initMockService("single-modem");

		const list = await mmList();

		expect(list).toEqual([0]);
		expect(spy).not.toHaveBeenCalled();
	});
});
