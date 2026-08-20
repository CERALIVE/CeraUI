/**
 * router-dongle-fields — a network CODE is never labelled as an operator NAME.
 *
 * FIXTURE PROVENANCE: `732103` is the value the bench ZTE MF79U answered on
 * 2026-08-18 (`network_provider`, with `network_provider_fullname` empty on that
 * firmware), and `No service.` is the bench Qualcomm UFI's own `carrier` string
 * from the same session. Both are verbatim, not shape-derived.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { decomposePlmn, detailFields } from "./router-dongle-fields";

type RouterAdminView = NonNullable<Modem["router_admin"]>;

function admin(details: Record<string, string>): RouterAdminView {
	return {
		admin_url: "http://192.168.0.1",
		reachable: true,
		details,
	} as unknown as RouterAdminView;
}

function providerRow(details: Record<string, string>) {
	return detailFields(admin(details)).find((field) => field.id === "provider");
}

describe("decomposePlmn", () => {
	it("splits a 6-digit PLMN at the E.212 three-digit MCC boundary", () => {
		expect(decomposePlmn("732103")).toEqual({ mcc: "732", mnc: "103" });
	});

	it("splits a 5-digit PLMN into a 3-digit MCC and a 2-digit MNC", () => {
		expect(decomposePlmn("21407")).toEqual({ mcc: "214", mnc: "07" });
	});

	it("refuses anything that is not 5 or 6 digits", () => {
		for (const value of ["", "7", "7321", "7321034", "73210a", "732 103"]) {
			expect(decomposePlmn(value), value).toBeUndefined();
		}
	});

	it("refuses an operator NAME, however short", () => {
		// The whole point: a name must keep the "Operator" label.
		for (const value of ["Claro", "Movistar", "No service.", "3", "O2"]) {
			expect(decomposePlmn(value), value).toBeUndefined();
		}
	});

	it("never maps a code to a carrier name", () => {
		// `decomposePlmn` returns DIGITS ONLY. If a future change adds a lookup
		// table, this fails — which is the intent: no operator name may be derived
		// from a numeric code without a first-party mapping the device supplied.
		const split = decomposePlmn("732103");
		expect(Object.values(split ?? {}).join("")).toMatch(/^\d+$/);
	});
});

describe("the provider row follows the value the dongle actually stated", () => {
	it("labels a bare PLMN as a network code and decodes it on screen", () => {
		const row = providerRow({ provider: "732103" });

		expect(row?.value).toBe("732103");
		expect(row?.label).toBe("Network code");
		expect(row?.label).not.toBe("Operator");
		// The caveat is ON SCREEN, not in a `title` — the shipped kiosk
		// touchscreen cannot hover, the same rule `station_id` already follows.
		expect(row?.note).toContain("MCC 732");
		expect(row?.note).toContain("MNC 103");
	});

	it("keeps the Operator label for a name the dongle really reported", () => {
		const row = providerRow({ provider: "Claro" });

		expect(row?.label).toBe("Operator");
		expect(row?.value).toBe("Claro");
		expect(row?.note).toBeUndefined();
	});

	it("treats the UFI's status sentence as a stated value, not a code", () => {
		const row = providerRow({ provider: "No service." });

		expect(row?.label).toBe("Operator");
		expect(row?.value).toBe("No service.");
		expect(row?.note).toBeUndefined();
	});

	it("still produces NO row when the dialect reported no provider at all", () => {
		// The bench HiLink twins: `registration` answers, `provider` never does.
		expect(providerRow({ registration: "NO SERVICE" })).toBeUndefined();
		expect(providerRow({ provider: "" })).toBeUndefined();
	});

	it("leaves every other field's label untouched", () => {
		const fields = detailFields(
			admin({ provider: "732103", network_type: "LTE", roaming: "Home" }),
		);
		const byId = new Map(fields.map((f) => [f.id, f]));

		expect(byId.get("network_type")?.value).toBe("LTE");
		expect(byId.get("roaming")?.value).toBe("Home");
		expect(byId.get("network_type")?.note).toBeUndefined();
		expect(byId.get("roaming")?.note).toBeUndefined();
	});
});
