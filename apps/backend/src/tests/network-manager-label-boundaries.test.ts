import { expect, test } from "bun:test";
import { parseNmcliFields } from "../modules/network/network-manager-output.ts";

const fields = ["connection.id", "match.path"];

test("captured nmcli output has one terminator LF and no separator lines", () => {
	// Owner's read-only nmcli 1.58.1 capture; target 1.52.1 is probed in the VM.
	const device = "GENERAL.DEVICE:lo\nGENERAL.TYPE:loopback\n";
	const table = "DEVICE:x\nTYPE:y\nDEVICE:x2\nTYPE:y2\n";
	expect(parseNmcliFields(device, ["GENERAL.DEVICE", "GENERAL.TYPE"])).toEqual(
		new Map([
			["general.device", "lo"],
			["general.type", "loopback"],
		]),
	);
	// A table is not a single settings record: duplicate labels must fail closed.
	expect(parseNmcliFields(table, ["DEVICE", "TYPE"])).toBeUndefined();
});

for (const [kind, value] of [
	["trailing LF", "Office\n"],
	["leading LF", "\nOffice"],
	["several trailing LFs", "Office\n\n\n"],
	["embedded blank line", "North\n\nOffice"],
	["CR and LF", "\r\nOffice\r\n"],
	["literal CR", "Office\r"],
	["empty", ""],
] as const) {
	for (const last of [false, true]) {
		test(`label boundary preserves ${kind}, last=${last}`, () => {
			const stdout = last
				? `match.path:\nconnection.id:${value}\n`
				: `connection.id:${value}\nmatch.path:\n`;
			const row = parseNmcliFields(stdout, fields);
			expect(row?.get("connection.id")).toBe(value);
			expect(row?.get("match.path")).toBe("");
		});
	}
}

for (const terminator of ["", "\n"]) {
	test(`last field accepts ${terminator ? "one" : "no"} final terminator LF`, () => {
		const row = parseNmcliFields(
			`match.path:\nconnection.id:Office${terminator}`,
			fields,
		);
		expect(row?.get("connection.id")).toBe("Office");
		expect(row?.get("match.path")).toBe("");
	});
}

test("a value resembling a later requested label is withheld on duplicate framing", () => {
	expect(
		parseNmcliFields("connection.id:x\nmatch.path:y\nmatch.path:\n", fields),
	).toBeUndefined();
});

test("a foreign label between requested labels is rejected", () => {
	expect(
		parseNmcliFields(
			"connection.id:Office\nunexpected.field:foreign\nmatch.path:\n",
			fields,
		),
	).toBeUndefined();
});
