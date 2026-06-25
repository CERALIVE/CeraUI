/*
 * S2 hardening — shared fail-loud CLI-parse primitives.
 *
 * Covers the typed parse-error constructors and, critically, describeCliError:
 * the helper that STOPS the stderr+exitCode from being discarded when a
 * mmcli/nmcli/systemctl/ip call exits non-zero.
 */

import { describe, expect, it, mock, spyOn } from "bun:test";

import { logger } from "../../helpers/logger.ts";
import {
	describeCliError,
	isParseError,
	logParseError,
	MAX_RAW_PARSE_CHARS,
	parseFail,
	parseOk,
} from "./cli-parse.ts";

describe("parseOk / parseFail / isParseError", () => {
	it("wraps a value as an ok result", () => {
		const r = parseOk([1, 2, 3]);
		expect(r.ok).toBe(true);
		expect(r.value).toEqual([1, 2, 3]);
		expect(isParseError(r)).toBe(false);
	});

	it("builds a typed, narrowable parse-error", () => {
		const e = parseFail("parseThing", "bad shape", "garbage");
		expect(e.ok).toBe(false);
		expect(isParseError(e)).toBe(true);
		expect(e.parser).toBe("parseThing");
		expect(e.reason).toBe("bad shape");
		expect(e.raw).toBe("garbage");
	});

	it("truncates an oversized raw output to the bound", () => {
		const huge = "x".repeat(MAX_RAW_PARSE_CHARS + 500);
		const e = parseFail("p", "drift", huge);
		expect(e.raw.length).toBeLessThan(huge.length);
		expect(e.raw).toContain("chars)");
	});

	it("rejects non-parse-error values in the guard", () => {
		expect(isParseError(null)).toBe(false);
		expect(isParseError({ ok: true, value: 1 })).toBe(false);
		expect(isParseError("parse-error")).toBe(false);
	});
});

describe("describeCliError — surfaces captured stderr + exit code", () => {
	it("renders message, exit code, and trimmed stderr from a non-zero exit", () => {
		const err = Object.assign(new Error("Command failed: mmcli -L"), {
			stdout: "",
			stderr: "  error: couldn't find the ModemManager process\n",
			code: 1,
		});
		const out = describeCliError(err);
		expect(out).toContain("Command failed: mmcli -L");
		expect(out).toContain("exit=1");
		expect(out).toContain(
			"stderr: error: couldn't find the ModemManager process",
		);
	});

	it("falls back to the plain message when there is no stderr/code", () => {
		expect(describeCliError(new Error("boom"))).toBe("boom");
	});

	it("stringifies a non-Error throw", () => {
		expect(describeCliError("oops")).toBe("oops");
	});
});

describe("logParseError", () => {
	it("logs at WARN with the raw output and returns the error", () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const e = parseFail("parseThing", "no match", "raw-bytes");
		const returned = logParseError(e);
		expect(returned).toBe(e);
		expect(warn).toHaveBeenCalledTimes(1);
		const [msg, meta] = warn.mock.calls[0] as [string, { raw: string }];
		expect(msg).toContain("parseThing");
		expect(meta.raw).toBe("raw-bytes");
		mock.restore();
	});
});
