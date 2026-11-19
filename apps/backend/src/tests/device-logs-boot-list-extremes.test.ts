import { expect, test } from "bun:test";
import { eventBootRecordSchema, logBootInfoSchema } from "@ceraui/rpc/schemas";
import {
	assembleBootList,
	journalBootsSchema,
} from "../modules/device-logs/boot-list.ts";

const a = "a".repeat(32),
	b = "b".repeat(32);
const max = Number.MAX_SAFE_INTEGER;
test("stored-only indices saturate at the admitted native minimum", () => {
	const journal = journalBootsSchema.parse([
		{
			boot_id: a,
			index: Number.MIN_SAFE_INTEGER,
			first_entry: 0,
			last_entry: max,
		},
	]);
	const rows = assembleBootList(
		journal,
		[{ bootId: b, startedAt: 0, versions: null }],
		undefined,
	);
	expect(rows.map((row) => row.index)).toEqual([
		Number.MIN_SAFE_INTEGER,
		Number.MIN_SAFE_INTEGER,
	]);
	for (const row of rows)
		expect(logBootInfoSchema.safeParse(row).success).toBe(true);
});
test.each([
	[-Number.MAX_VALUE, 0],
	[Number.MIN_SAFE_INTEGER, 0],
	[-1, 0],
	[0, 0],
	[0.5, 0],
	[1, 1],
	[max - 1, max - 1],
	[max, max],
	[Number.MAX_VALUE, max],
] as const)(
	"admitted stored boot time %s projects to valid timestamp %s",
	(startedAt, expected) => {
		const stored = eventBootRecordSchema.parse({
			bootId: a,
			startedAt,
			versions: null,
		});
		const result = assembleBootList([], [stored], undefined);
		expect(result[0]).toMatchObject({ firstTs: expected, lastTs: expected });
		expect(logBootInfoSchema.safeParse(result[0]).success).toBe(true);
	},
);
test("native extreme indices still sort by sign and extreme microseconds retain exact milliseconds", () => {
	const journal = journalBootsSchema.parse([
		{
			boot_id: a,
			index: Number.MIN_SAFE_INTEGER,
			first_entry: 0,
			last_entry: max,
		},
		{ boot_id: b, index: max, first_entry: max, last_entry: max },
	]);
	const rows = assembleBootList(journal, [], b);
	expect(rows.map((row) => row.bootId)).toEqual([b, a]);
	expect(rows[0]).toMatchObject({
		firstTs: Number(BigInt(max) / 1000n),
		lastTs: Number(BigInt(max) / 1000n),
	});
	for (const row of rows)
		expect(logBootInfoSchema.safeParse(row).success).toBe(true);
});
