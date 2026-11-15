import { expect, test } from "bun:test";
import { versionContextSchema } from "@ceraui/rpc/schemas";
import { assembleBootList } from "../modules/device-logs/boot-list.ts";

const a = "a".repeat(32),
	b = "b".repeat(32),
	c = "c".repeat(32);
test("stored versions and latest duplicate records survive boot-list assembly", () => {
	const versions = versionContextSchema.parse({
		bootId: a,
		osImage: "beta",
		slot: "B",
		board: "rock",
		boardModel: "model",
		ceraui: "2026.11.3",
		engine: "2026.11.1",
		senderVersion: "1.0",
		kernel: "7.3",
		bun: "1.4.4",
	});
	const result = assembleBootList(
		[
			{ boot_id: a, index: -7, first_entry: 1999, last_entry: 3999 },
			{ boot_id: b, index: 0, first_entry: 4000, last_entry: 5000 },
		],
		[
			{ bootId: a, startedAt: 0, versions: null },
			{ bootId: a, startedAt: 1, versions },
			{ bootId: c, startedAt: 20, versions: { ...versions, bootId: c } },
		],
		c,
	);
	expect(
		result.map((row) => [
			row.bootId,
			row.index,
			row.firstTs,
			row.lastTs,
			row.current,
			row.shutdown,
			row.logsAvailable,
			row.versions,
		]),
	).toEqual([
		[b, 0, 4, 5, false, "unknown", true, null],
		[a, -7, 1, 3, false, "unknown", true, versions],
		[c, -8, 20, 20, true, "current", false, { ...versions, bootId: c }],
	]);
});
test.each([
	[a, [true, false], ["current", "unknown"]],
	[b, [false, true], ["unknown", "current"]],
	[c, [false, false], ["unknown", "unknown"]],
	[undefined, [false, false], ["unknown", "unknown"]],
] as const)(
	"current identity %s marks only its own row",
	(current, flags, shutdowns) => {
		const result = assembleBootList(
			[
				{ boot_id: a, index: -1, first_entry: 0, last_entry: 1000 },
				{ boot_id: b, index: 0, first_entry: 1000, last_entry: 2000 },
			],
			[],
			current,
		).reverse();
		expect(result.map((row) => row.current)).toEqual([...flags]);
		expect(result.map((row) => row.shutdown)).toEqual([...shutdowns]);
	},
);
test("stored-only rows are retained below the minimum journal index, including empty history", () => {
	const stored = { bootId: a, startedAt: 10, versions: null };
	expect(assembleBootList([], [stored], undefined)).toEqual([
		{
			bootId: a,
			index: -1,
			firstTs: 10,
			lastTs: 10,
			current: false,
			shutdown: "unknown",
			evidence: [],
			logsAvailable: false,
			versions: null,
		},
	]);
	const native = { boot_id: b, index: 0, first_entry: 0, last_entry: 1000 };
	expect(
		assembleBootList([native], [stored], undefined).map((row) => [
			row.bootId,
			row.index,
		]),
	).toEqual([
		[b, 0],
		[a, -1],
	]);
	expect(
		assembleBootList([native], [{ ...stored, bootId: b }], undefined),
	).toHaveLength(1);
});
test("multiple archived journal boots sort newest first rather than retaining input order", () => {
	const rows = [a, b, c].map((boot_id, index) => ({
		boot_id,
		index: index - 2,
		first_entry: 0,
		last_entry: 1000,
	}));
	expect(assembleBootList(rows, [], c).map((row) => row.bootId)).toEqual([
		c,
		b,
		a,
	]);
});
test.each([a, b, c, undefined])(
	"stored-only current flags use exact identity %s",
	(current) => {
		const rows = assembleBootList(
			[],
			[
				{ bootId: a, startedAt: 1, versions: null },
				{ bootId: c, startedAt: 2, versions: null },
			],
			current,
		);
		expect(rows.map((row) => row.current)).toEqual([
			current === a,
			current === c,
		]);
		expect(rows.map((row) => row.shutdown)).toEqual([
			current === a ? "current" : "unknown",
			current === c ? "current" : "unknown",
		]);
	},
);
