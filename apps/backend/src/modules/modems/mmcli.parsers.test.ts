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
	mmcliParseSep,
	mmcliUnescapeValue,
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

/*
 * mmcli's `-K` writer escapes EVERY value it prints (`cli/mmcli-output.c`,
 * `dump_output_keyvalue` → `g_strescape`), so this is a property of the CLI,
 * not of any one command. Before this decoder existed mmcliParseSep deleted
 * `\<digits>` runs outright, which truncated non-ASCII operator names to their
 * ASCII skeleton — the regression these tests hold shut.
 */
describe("mmcliUnescapeValue — undoing g_strescape", () => {
	it("returns a pure-ASCII value untouched", () => {
		expect(mmcliUnescapeValue("QUECTEL Mobile Broadband Module")).toBe(
			"QUECTEL Mobile Broadband Module",
		);
		expect(mmcliUnescapeValue("")).toBe("");
	});

	it("rebuilds a multi-byte character from its escaped BYTES", () => {
		expect(mmcliUnescapeValue(String.raw`Telef\303\263nica`)).toBe(
			"Telefónica",
		);
		expect(mmcliUnescapeValue(String.raw`\302\241Hola!`)).toBe("¡Hola!");
		expect(mmcliUnescapeValue(String.raw`\346\227\245\346\234\254`)).toBe(
			"日本",
		);
	});

	it("decodes the C escapes g_strescape emits besides octal", () => {
		expect(mmcliUnescapeValue(String.raw`one\ntwo`)).toBe("one\ntwo");
		expect(mmcliUnescapeValue(String.raw`a\tb`)).toBe("a\tb");
		expect(mmcliUnescapeValue(String.raw`say \"hi\"`)).toBe('say "hi"');
	});

	it("keeps an escaped backslash from swallowing the digits after it", () => {
		// `\\302` is a literal backslash followed by "302" — NOT the byte 0xC2.
		expect(mmcliUnescapeValue(String.raw`C:\\302`)).toBe("C:\\302");
	});

	it("passes an escape outside mmcli's grammar through verbatim", () => {
		expect(mmcliUnescapeValue(String.raw`\9 \z`)).toBe(String.raw`\9 \z`);
	});

	it("marks an undecodable byte instead of failing the whole value", () => {
		expect(mmcliUnescapeValue(String.raw`ok\377`)).toBe("ok\uFFFD");
	});
});

describe("mmcliParseSep — values arrive decoded, never truncated", () => {
	it("no longer deletes the escaped bytes of a non-ASCII operator name", () => {
		const parsed = mmcliParseSep(
			String.raw`modem.3gpp.operator-name : Telef\303\263nica M\303\263viles`,
		);
		expect(parsed["modem.3gpp.operator-name"]).toBe("Telefónica Móviles");
	});

	it("decodes array values too", () => {
		const parsed = mmcliParseSep(
			[
				"modem.3gpp.scan-networks.length   : 1",
				String.raw`modem.3gpp.scan-networks.value[1] : operator-name: Telef\303\263nica`,
			].join("\n"),
		);
		expect(parsed["modem.3gpp.scan-networks"]).toEqual([
			"operator-name: Telefónica",
		]);
	});

	it("still drops mmcli's `--` empties and keeps plain values intact", () => {
		const parsed = mmcliParseSep(
			[
				"modem.generic.state    : connected",
				"modem.generic.model    : --",
			].join("\n"),
		);
		expect(parsed["modem.generic.state"]).toBe("connected");
		expect(Object.hasOwn(parsed, "modem.generic.model")).toBe(false);
	});
});
