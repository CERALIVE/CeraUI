/*
 * S2 hardening — named, fail-loud mmcli parsers.
 *
 * Happy-path AND malformed-input (output-drift) cases for every extracted
 * parser. The stderr+exitCode surfacing of the call sites that consume these
 * parsers is covered centrally by cli-parse.test.ts (describeCliError) — the
 * run()/execFileP spawn seam can't be reliably spied under Bun 1.3.14's ESM
 * re-export binding (the pre-existing mmcli-mode-validation suite hits the same
 * limit), so consumer drift wiring is proven via gateways' DI runner instead.
 */

import { describe, expect, it } from "bun:test";

import { isParseError } from "../system/cli-parse.ts";
import {
	parseModemList,
	parseNetworkScanResults,
	parseSetModesSuccess,
} from "./mmcli.ts";

describe("parseModemList — modem index extraction", () => {
	it("extracts indices from a well-formed modem-list", () => {
		const r = parseModemList({
			"modem-list": [
				"/org/freedesktop/ModemManager1/Modem/0",
				"/org/freedesktop/ModemManager1/Modem/3",
			],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toEqual([0, 3]);
	});

	it("treats an empty modem-list as a valid zero-modem result", () => {
		const r = parseModemList({ "modem-list": [] });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toEqual([]);
	});

	it("fails loud when the modem-list key is missing (drift)", () => {
		const r = parseModemList({ "some-other-key": "x" });
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("missing modem-list");
	});

	it("fails loud when entries match no path grammar (drift)", () => {
		const r = parseModemList({ "modem-list": ["totally-different-format"] });
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("path grammar");
	});
});

describe("parseNetworkScanResults — 3GPP scan rows", () => {
	it("parses operator rows into structured results", () => {
		const r = parseNetworkScanResults({
			"modem.3gpp.scan-networks": [
				"operator-code: 23410, operator-name: giffgaff, availability: available",
			],
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value).toHaveLength(1);
			expect(r.value[0]?.["operator-code"]).toBe("23410");
			expect(r.value[0]?.["operator-name"]).toBe("giffgaff");
		}
	});

	it("treats a missing scan-networks key as an empty scan", () => {
		const r = parseNetworkScanResults({});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toEqual([]);
	});

	it("fails loud on an entry that carries no operator fields (drift)", () => {
		const r = parseNetworkScanResults({
			"modem.3gpp.scan-networks": ["garbage without colons or operators"],
		});
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("operator");
	});
});

describe("parseSetModesSuccess", () => {
	it("returns true on mmcli's confirmation line", () => {
		expect(
			parseSetModesSuccess("successfully set current modes in the modem\n"),
		).toBe(true);
	});

	it("returns false on any other output", () => {
		expect(parseSetModesSuccess("error: operation failed")).toBe(false);
		expect(parseSetModesSuccess("")).toBe(false);
	});
});
