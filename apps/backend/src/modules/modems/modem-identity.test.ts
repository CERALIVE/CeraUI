/*
 * Hardware naming for mmcli-managed modems, proven against REAL `mmcli -K -m N`
 * output captured from the bench board on 2026-08-17 — all four modems that
 * were attached at the time, verbatim (the Quectel's own-number is the single
 * redaction, it plays no part in naming).
 *
 * The fixtures are the point of this suite: the garbage-identity rule has to be
 * narrow enough that three real SKUs keep the exact titles they already had, so
 * inventing the shapes it must not flag would prove nothing.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type ModemInfo, mmcliParseSep, parseModemInfo } from "./mmcli.ts";
import {
	firmwareIdentityLabel,
	isUninformativeIdentity,
	modemHardwareName,
} from "./modem-identity.ts";

const FIXTURE_DIR = join(import.meta.dir, "../../tests/fixtures/network");

function realModem(name: string): ModemInfo {
	const raw = readFileSync(join(FIXTURE_DIR, `mmcli-modem-real-${name}.txt`), {
		encoding: "utf8",
	});
	const parsed = parseModemInfo(mmcliParseSep(raw));
	if (!parsed.ok) throw new Error(`fixture ${name} failed to parse`);
	return parsed.value;
}

function nameOf(info: ModemInfo): string {
	return modemHardwareName({
		model: info["modem.generic.model"],
		manufacturer: info["modem.generic.manufacturer"],
		firmwareRevision: info["modem.generic.revision"],
		equipmentId: info["modem.generic.equipment-identifier"],
	});
}

describe("real bench hardware — mmcli -K fixtures", () => {
	it("carries manufacturer and revision through the parser", () => {
		const himi = realModem("himi-u01");
		expect(himi["modem.generic.manufacturer"]).toBe("1");
		expect(himi["modem.generic.model"]).toBe("0");
		expect(himi["modem.generic.revision"]).toBe(
			"HIMI_U01_MODEM_V1.0  1  [Sep 09 2015 10:00:00]",
		);
	});

	it("names the garbage-identity modem by its firmware, never '0 - 54863'", () => {
		const name = nameOf(realModem("himi-u01"));
		expect(name).toBe("HIMI_U01_MODEM_V1.0 - 54863");
		expect(name).not.toBe("0 - 54863");
	});

	it("leaves the Quectel RM530N-GL title untouched", () => {
		expect(nameOf(realModem("quectel-rm530n-gl"))).toBe("RM530N-GL - 16855");
	});

	it("leaves the SIMCom SIM7600G-H title untouched", () => {
		expect(nameOf(realModem("simcom-sim7600g-h"))).toBe(
			"SIMCOM_SIM7600G-H - 15136",
		);
	});

	it("leaves the Fibocom FM350-GL title untouched", () => {
		expect(nameOf(realModem("fibocom-fm350-gl"))).toBe("FM350-GL - 01765");
	});
});

describe("isUninformativeIdentity", () => {
	it("flags the measured garbage answers", () => {
		expect(isUninformativeIdentity("0")).toBe(true);
		expect(isUninformativeIdentity("1")).toBe(true);
		expect(isUninformativeIdentity(" 1 ")).toBe(true);
	});

	it("flags absent, empty and mmcli's '--' placeholder", () => {
		expect(isUninformativeIdentity(undefined)).toBe(true);
		expect(isUninformativeIdentity("")).toBe(true);
		expect(isUninformativeIdentity("--")).toBe(true);
	});

	it("accepts every real manufacturer and model on the bench", () => {
		for (const value of [
			"Quectel",
			"RM530N-GL",
			"QUALCOMM INCORPORATED",
			"SIMCOM_SIM7600G-H",
			"Fibocom Wireless Inc.",
			"FM350-GL",
		]) {
			expect(isUninformativeIdentity(value)).toBe(false);
		}
	});

	it("does not flag short names that are not bare numerals", () => {
		for (const value of ["E3372", "MF79U", "5G", "H", "U01"]) {
			expect(isUninformativeIdentity(value)).toBe(false);
		}
	});

	it("does not flag a long digit run, which identifies something", () => {
		expect(isUninformativeIdentity("81600")).toBe(false);
		expect(isUninformativeIdentity("868837088254863")).toBe(false);
	});
});

describe("firmwareIdentityLabel", () => {
	it("keeps only the name part of a padded revision", () => {
		expect(
			firmwareIdentityLabel("HIMI_U01_MODEM_V1.0  1  [Sep 09 2015 10:00:00]"),
		).toBe("HIMI_U01_MODEM_V1.0");
	});

	it("passes a plain revision through untouched", () => {
		expect(firmwareIdentityLabel("RM530NGLAAR05A01M4G")).toBe(
			"RM530NGLAAR05A01M4G",
		);
		expect(firmwareIdentityLabel("LE20B04SIM7600G22")).toBe(
			"LE20B04SIM7600G22",
		);
	});

	it("refuses a revision that is itself number soup", () => {
		expect(firmwareIdentityLabel("81600.0000.00.19.17.10")).toBeUndefined();
		expect(firmwareIdentityLabel("10000")).toBeUndefined();
	});

	it("refuses absent, empty and '--' revisions", () => {
		expect(firmwareIdentityLabel(undefined)).toBeUndefined();
		expect(firmwareIdentityLabel("  ")).toBeUndefined();
		expect(firmwareIdentityLabel("--")).toBeUndefined();
	});
});

describe("modemHardwareName fallback order", () => {
	it("prefers the manufacturer when the firmware cannot name anything", () => {
		expect(
			modemHardwareName({
				model: "0",
				manufacturer: "Quectel",
				firmwareRevision: "81600.0000.00.19.17.10",
				equipmentId: "867978050016855",
			}),
		).toBe("Quectel - 16855");
	});

	it("says only what is certain when every identity field is garbage", () => {
		expect(
			modemHardwareName({
				model: "0",
				manufacturer: "1",
				equipmentId: "868837088254863",
			}),
		).toBe("Cellular modem - 54863");
	});

	it("drops the separator when the device published no IMEI", () => {
		expect(modemHardwareName({ model: "FM350-GL" })).toBe("FM350-GL");
		expect(modemHardwareName({ model: "FM350-GL", equipmentId: "--" })).toBe(
			"FM350-GL",
		);
	});
});
