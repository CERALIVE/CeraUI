import { afterEach, beforeEach, expect, test } from "bun:test";
import { logAroundOutputSchema } from "@ceraui/rpc/schemas";
import { locateAround, queryLogs } from "../modules/device-logs/query.ts";
import { scanJournal } from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
} from "./helpers/device-journal.ts";
import { bootId, queryFixture, socket } from "./helpers/device-query.ts";

const scan = scanJournal;
const at = 100_500;
let fixture: ReturnType<typeof queryFixture>;
beforeEach(() => {
	fixture = queryFixture();
});
afterEach(() => fixture.restore());

function useJournal(timestamps: readonly number[]) {
	const records = timestamps.map((ts, index) => ({
		ts,
		cursor: `s=${index}`,
		line: journalLine({
			__CURSOR: `s=${index}`,
			__REALTIME_TIMESTAMP: String(ts * 1000 + 321),
			_SYSTEMD_UNIT: "ceralive.service",
		}),
	}));
	fixture.scan.mockImplementation((input) => {
		const reverse = input.options.includes("-r");
		const rows = reverse ? records.toReversed() : records;
		const cursor = input.options
			.find((option) => option.startsWith("--cursor="))
			?.slice("--cursor=".length);
		const since = input.options.find((option) =>
			option.startsWith("--since=@"),
		);
		const until = input.options.find((option) =>
			option.startsWith("--until=@"),
		);
		const lower = since ? Number(since.split("@")[1]) * 1000 : 0;
		const upper = until ? Number(until.split("@")[1]) * 1000 : Infinity;
		// Like journalctl, seek on one edge and stop at the other in journal order.
		const start = rows.findIndex((row) =>
			cursor !== undefined
				? row.cursor === cursor
				: reverse
					? row.ts < upper
					: row.ts >= lower,
		);
		const lines: string[] = [];
		if (start >= 0) {
			for (const row of rows.slice(start)) {
				if (reverse ? row.ts < lower : row.ts >= upper) break;
				lines.push(row.line);
			}
		}
		const { child } = fakeJournal(lines);
		return scan({ ...input, spawn: () => child, clock: manualClock().clock });
	});
}

test.each([
	{ older: [at - 1, at], newer: [at + 1], label: "both sides" },
	{ older: [at - 1, at], newer: [], label: "only older" },
	{ older: [], newer: [at + 1], label: "only newer" },
])(
	"finds approximate rows behind 5,000 unrelated records on $label",
	async ({ older, newer }) => {
		useJournal([
			...Array<number>(5000).fill(at - 61_000),
			...older,
			...newer,
			...Array<number>(5000).fill(at + 61_000),
		]);

		const result = logAroundOutputSchema.parse(
			await locateAround(socket(), { bootId, at, eventId: "absent" }),
		);

		if (!result.ok) throw new Error(result.error);
		expect(result).toMatchObject({ approximate: true, anchor: null });
		expect(result.older.entries.map((row) => row.ts)).toEqual(
			older.toReversed(),
		);
		expect(result.newer.entries.map((row) => row.ts)).toEqual([...newer]);
		for (const page of [result.older, result.newer]) {
			expect(page).toMatchObject({ hasMore: null, termination: "budget" });
			expect(typeof page.continuation).toBe("string");
		}
	},
);

test("clock-step fallback recovers entries after a native cutoff in journal order", async () => {
	useJournal([at - 40, at - 61_000, at, at + 1, at + 61_000, at + 100]);

	const result = await locateAround(socket(), { bootId, at });

	if (!result.ok) throw new Error(result.error);
	expect(result.older.entries.map((row) => row.ts)).toEqual([at, at - 40]);
	expect(result.newer.entries.map((row) => row.ts)).toEqual([at + 1, at + 100]);
	expect(result.older.termination).toBe("end");
	expect(result.newer.termination).toBe("end");
});

test("approximate continuations keep the page boundary and exact inclusive time bounds", async () => {
	const older = Array.from({ length: 50 }, (_, i) => at - i);
	const newer = Array.from({ length: 50 }, (_, i) => at + 1 + i);
	useJournal([
		at - 60_001,
		at - 60_000,
		...older.toReversed(),
		...newer,
		at + 60_000,
		at + 60_001,
	]);
	const conn = socket();

	const result = await locateAround(conn, { bootId, at, eventId: "absent" });

	if (!result.ok) throw new Error(result.error);
	expect(result.older.entries.map((row) => row.ts)).toEqual(older);
	expect(result.newer.entries.map((row) => row.ts)).toEqual(newer);
	for (const [page, query, boundary] of [
		[result.older, result.olderQuery, at - 60_000],
		[result.newer, result.newerQuery, at + 60_000],
	] as const) {
		expect(page.termination).toBe("lookahead");
		if (page.continuation === null) throw new Error("missing continuation");
		const next = await queryLogs(conn, {
			...query,
			continuation: page.continuation,
		});
		if (!next.ok) throw new Error(next.error);
		expect(next.entries.map((row) => row.ts)).toEqual([boundary]);
		expect(next).toMatchObject({
			hasMore: false,
			termination: "end",
			continuation: null,
		});
	}
});
