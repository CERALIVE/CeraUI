import { expect, test } from "bun:test";
import { wifiStatusSchema } from "@ceraui/rpc/schemas";
import { radioEquivalenceCases } from "./fixtures/wifi/radio-equivalence-cases.ts";
import {
	type EquivalenceFixture,
	radioEquivalenceTranscript,
} from "./helpers/wifi-radio-equivalence.ts";

for (const fixture of radioEquivalenceCases) {
	test(`real status emits parsed observational tokens: ${fixture.name}`, async () => {
		await radioEquivalenceTranscript(fixture, false, (rows) => {
			const parsed = wifiStatusSchema.parse(rows);
			expect(Object.keys(parsed)).toEqual(Object.keys(rows));
			for (const [id, row] of Object.entries(rows)) {
				expect(row.incarnation).toEqual(expect.any(String));
				expect(row.incarnation).not.toBe("");
				expect(parsed[id]?.incarnation).toBe(row.incarnation);
			}
		});
	});
}

const verified = radioEquivalenceCases[0]?.frames[0]?.[0];
if (!verified) throw new Error("Missing verified discovery fixture");

for (const [name, frames, same] of [
	["same binding", [[verified], [{ ...verified, state: "connected" }]], true],
	["rename", [[verified], [{ ...verified, ifname: "wlp-renamed" }]], true],
	["replug", [[verified], [], [{ ...verified, ifindex: 24, phy: 2 }]], false],
] as const) {
	test(`real status token ${same ? "survives" : "rotates on"} ${name}`, async () => {
		const tokens: string[] = [];
		const fixture: EquivalenceFixture = { name, frames, admitted: true };
		await radioEquivalenceTranscript(fixture, false, (rows) => {
			for (const row of Object.values(rows)) {
				if (row.incarnation !== undefined) tokens.push(row.incarnation);
			}
		});
		expect(tokens).toHaveLength(2);
		if (same) expect(tokens[1]).toBe(tokens[0]);
		else expect(tokens[1]).not.toBe(tokens[0]);
	});
}

test("unavailable and recovery each rotate once without changing legacy actions", async () => {
	const rows: Array<ReturnType<typeof wifiStatusSchema.parse>> = [];
	await radioEquivalenceTranscript(
		{
			name: "unavailable recovery",
			admitted: true,
			frames: [
				[verified],
				[{ ...verified, state: "unavailable" }],
				[{ ...verified, state: "unavailable" }],
				[verified],
			],
		},
		false,
		(status) => rows.push(wifiStatusSchema.parse(status)),
	);
	const tokens = rows.map((status) => status[0]?.incarnation);
	expect(tokens).toHaveLength(4);
	expect(tokens[0]).toEqual(expect.any(String));
	expect(tokens[1]).not.toBe(tokens[0]);
	expect(tokens[2]).toBe(tokens[1]);
	expect(tokens[3]).not.toBe(tokens[2]);
});
