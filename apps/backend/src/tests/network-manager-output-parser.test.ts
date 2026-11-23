import { expect, test } from "bun:test";
import { parseNmcliFields } from "../modules/network/network-manager-output.ts";

const UUID = "6f1ba4d4-a753-4782-a1ab-a09246a5ec46";

test("named values retain whitespace, literal colons and backslashes in any field order", () => {
	const fields = ["connection.id", "802-11-wireless.ssid", "match.path"];
	const value = " Office:\\ ";
	const row = parseNmcliFields(
		`802-11-wireless.ssid:${value}\nCONNECTION.ID:Client\n`,
		fields,
	);
	expect(row).toEqual(
		new Map([
			["802-11-wireless.ssid", value],
			["connection.id", "Client"],
		]),
	);
});

for (const raw of [
	"unlabelled metadata\n",
	"connection.id:Client\nconnection.id:Another\n",
	"unexpected.field:foreign\n",
]) {
	test(`malformed named output is rejected, shape=${raw.indexOf(":") < 0 ? "unlabelled" : raw.startsWith("unexpected") ? "unexpected" : "duplicate"}`, () => {
		expect(parseNmcliFields(raw, ["connection.id"])).toBeUndefined();
	});
}

test("empty named output differs from a present empty field", () => {
	expect(parseNmcliFields("", ["GENERAL.STATE"])).toEqual(new Map());
	expect(
		parseNmcliFields("GENERAL.STATE:\n", ["GENERAL.STATE"])?.get(
			"general.state",
		),
	).toBe("");
});

test("an explicit property selector rejects a nested foreign label", () => {
	expect(
		parseNmcliFields("connection.id.extra:foreign\n", ["connection.id"]),
	).toBeUndefined();
});

test("indexed device fields remain keyed with literal colons in their values", () => {
	const row = parseNmcliFields(
		`CONNECTIONS.AVAILABLE-CONNECTIONS[1]:${UUID} | Client: one\\\nCONNECTIONS.AVAILABLE-CONNECTIONS[2]:another | Client two\n`,
		["CONNECTIONS.AVAILABLE-CONNECTIONS"],
	);
	expect(row).toEqual(
		new Map([
			["connections.available-connections[1]", `${UUID} | Client: one\\`],
			["connections.available-connections[2]", "another | Client two"],
		]),
	);
});
