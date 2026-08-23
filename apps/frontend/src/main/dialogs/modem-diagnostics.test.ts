/**
 * The diagnostics dump and its disclosure boundary.
 *
 * Two properties are asserted, and the second is the one with teeth: the rows
 * carry every raw token the modem published (OL-3 — relocated, never deleted),
 * and NO subscriber identifier survives serialization of that payload.
 *
 * The redaction test is deliberately written as a SERIALIZATION GREP rather than
 * a per-row lookup. A row-by-row assertion only ever covers the fields somebody
 * thought to list, so the next field added here would not be covered by it; a
 * grep over `JSON.stringify` of the whole payload covers the fields nobody
 * thought about, which is the class this boundary exists for.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	DIAGNOSTIC_REDACTED,
	isSubscriberIdentifierKey,
	redactDiagnosticRows,
} from "$lib/modem/diagnostics-redaction";
import { modemDiagnosticRows } from "./modem-diagnostics";

const ICCID = "8931086518104172482";
const OWN_NUMBER = "+573115422359";

function modem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		device_class: "usb",
		stable_key: "platform-xhci-hcd.0-usb-1:2",
		recommended_usb_mode: "mbim",
		radio_power: "on",
		firmware_revision: "RM520NGLAAR01A07M4G",
		iccid: ICCID,
		own_numbers: [OWN_NUMBER],
		cell_info: {
			tech: "nr",
			band: "ngran-78",
			cell_id: "134318388",
			rsrp: -84,
			provenance: { source: "qmi", observed_at: 1_755_000_000 },
		},
		...overrides,
	} as Modem;
}

const rowFor = (id: string) =>
	modemDiagnosticRows(modem()).find((row) => row.id === id);

describe("modemDiagnosticRows — every raw token, relocated", () => {
	it("carries the tokens the operator labels replaced, verbatim", () => {
		expect(rowFor("serving-band")?.value).toBe("ngran-78");
		expect(rowFor("cell_info.tech")?.value).toBe("nr");
		expect(rowFor("cell_info.cell_id")?.value).toBe("134318388");
		expect(rowFor("cell_info.provenance.source")?.value).toBe("qmi");
		expect(rowFor("device_class")?.value).toBe("usb");
	});

	it("labels a row with the WIRE field name, so it matches a vendor table", () => {
		expect(rowFor("serving-band")?.label).toBe("cell_info.band");
		expect(rowFor("device_class")?.label).toBe("device_class");
	});

	it("a field the device did not state produces NO row, never a dash", () => {
		const quiet = modemDiagnosticRows(
			modem({
				device_class: undefined,
				stable_key: undefined,
				recommended_usb_mode: undefined,
				radio_power: undefined,
				firmware_revision: undefined,
				iccid: undefined,
				own_numbers: undefined,
				cell_info: undefined,
			}),
		);

		expect(quiet).toEqual([]);
	});

	// `usb_mode` is the ONE modem-row token this module withholds: the dialog
	// holds a live composition read that follows an in-flight switch, so a row
	// from here would have to be corrected the moment it rendered.
	it("withholds usb_mode, which the dialog supplies from its live read", () => {
		expect(rowFor("usb_mode")).toBeUndefined();
		expect(rowFor("usb-mode")).toBeUndefined();
	});
});

describe("the disclosure boundary", () => {
	it("serializing the payload finds no unredacted subscriber identifier", () => {
		const serialized = JSON.stringify(modemDiagnosticRows(modem()));

		expect(serialized).not.toContain(ICCID);
		expect(serialized).not.toContain(OWN_NUMBER);
	});

	// NON-VACUITY: the grep above passes trivially if the fields were never
	// collected. The rows must EXIST and read as the marker — a dropped row is
	// indistinguishable from a field the device never stated, which is the one
	// claim a diagnostics table may not make.
	it("retains the identifier ROWS and masks only their VALUES", () => {
		expect(rowFor("iccid")?.value).toBe(DIAGNOSTIC_REDACTED);
		expect(rowFor("own_numbers")?.value).toBe(DIAGNOSTIC_REDACTED);
	});

	it("masks by key class, so a field nobody listed here is still covered", () => {
		expect(
			redactDiagnosticRows([
				{ id: "sim.properties.imsi", label: "imsi", value: "732101234567890" },
				{ id: "Equipment-Identifier", label: "imei", value: "867698041234567" },
				{ id: "cell_info.band", label: "band", value: "ngran-78" },
			]),
		).toEqual([
			{
				id: "sim.properties.imsi",
				label: "imsi",
				value: DIAGNOSTIC_REDACTED,
			},
			{
				id: "Equipment-Identifier",
				label: "imei",
				value: DIAGNOSTIC_REDACTED,
			},
			{ id: "cell_info.band", label: "band", value: "ngran-78" },
		]);
	});

	it("classifies case-, separator- and dot-insensitively, and nothing else", () => {
		for (const key of [
			"iccid",
			"ICCID",
			"imsi",
			"imei",
			"equipment_identifier",
			"Equipment-Identifier",
			"sim.properties.iccid",
			"own_numbers",
			"msisdn",
			"password",
		]) {
			expect(isSubscriberIdentifierKey(key)).toBe(true);
		}
		for (const key of [
			"cell_info.band",
			"device_class",
			"stable_key",
			"firmware_revision",
			"password-flags",
			"slot",
		]) {
			expect(isSubscriberIdentifierKey(key)).toBe(false);
		}
	});

	it("returns an unaffected row by reference, so a clean table is untouched", () => {
		const clean = { id: "cell_info.band", label: "band", value: "ngran-78" };
		expect(redactDiagnosticRows([clean])[0]).toBe(clean);
	});
});
