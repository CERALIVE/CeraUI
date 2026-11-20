import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	logAroundInputSchema,
	logAroundOutputSchema,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import { locateAround } from "../modules/device-logs/query.ts";
import {
	bootId,
	eventMessage,
	journal,
	queryFixture,
	record,
	socket,
} from "./helpers/device-query.ts";

const max = Number.MAX_SAFE_INTEGER;
const extremes = [
	0,
	1,
	4999,
	5000,
	5001,
	59_999,
	60_000,
	60_001,
	max - 60_001,
	max - 60_000,
	max - 59_999,
	max - 5001,
	max - 5000,
	max - 4999,
	max - 2,
	max - 1,
	max,
];
const timestamps = [
	0,
	1,
	4999,
	5000,
	60_000,
	60_001,
	max - 60_001,
	max - 60_000,
	max - 59_999,
	max - 5000,
	max - 1,
	max,
];
let fixture: ReturnType<typeof queryFixture>;
beforeEach(() => {
	fixture = queryFixture();
});
afterEach(() => fixture.restore());
test.each([-1, Number.MIN_SAFE_INTEGER, 0.5, max + 1, Number.MAX_VALUE])(
	"timestamp %s remains outside admission",
	(at) =>
		expect(logAroundInputSchema.safeParse({ bootId, at }).success).toBe(false),
);

test.each(extremes)(
	"admitted timestamp %i has valid disjoint approximate pages",
	async (at) => {
		const rows = timestamps.map((ts, index) => ({ ...record(index + 1), ts }));
		fixture.scan.mockImplementation(journal(rows));
		const input = logAroundInputSchema.parse({ bootId, at });
		const result = logAroundOutputSchema.parse(
			await locateAround(socket(), input),
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.approximate).toBe(true);
		expect(result.anchor).toBeNull();
		const center = BigInt(at);
		const lower = center > 60_000n ? center - 60_000n : 0n;
		const upper =
			center + 60_000n > BigInt(max) ? BigInt(max) : center + 60_000n;
		expect(result.older.entries.map((row) => row.ts)).toEqual(
			[...timestamps]
				.reverse()
				.filter((ts) => BigInt(ts) >= lower && BigInt(ts) <= center),
		);
		expect(result.newer.entries.map((row) => row.ts)).toEqual(
			timestamps.filter((ts) => BigInt(ts) > center && BigInt(ts) <= upper),
		);
		expect(logQueryInputSchema.safeParse(result.olderQuery).success).toBe(true);
		expect(logQueryInputSchema.safeParse(result.newerQuery).success).toBe(true);
		expect(result.newer).toMatchObject({
			hasMore: false,
			termination: "end",
			continuation: null,
		});
	},
);

test.each(extremes)(
	"an unsuccessful event seek at %i preserves valid fallback bounds",
	async (at) => {
		fixture.scan.mockImplementation(journal([]));
		const input = logAroundInputSchema.parse({
			bootId,
			at,
			eventId: "missing",
		});
		const result = logAroundOutputSchema.parse(
			await locateAround(socket(), input),
		);
		expect(result).toMatchObject({ ok: true, anchor: null, approximate: true });
		const first = fixture.scan.mock.calls[0]?.[0];
		const center = BigInt(at);
		const since = center < 5000n ? 0n : center - 5000n;
		const until = center + 5000n < BigInt(max) ? center + 5000n : BigInt(max);
		expect(first?.options).toEqual([
			`--since=@${since / 1000n}`,
			`--until=@${until / 1000n + 1n}`,
		]);
	},
);

test.each([max - 1, max])(
	"event anchors at %i retain exact surrounding journal order",
	async (at) => {
		const rows = [
			{ ...record(1), ts: 0 },
			{ ...record(2, { MESSAGE: eventMessage }), ts: at },
			{ ...record(3), ts: 1 },
		];
		fixture.scan.mockImplementation(journal(rows));
		const result = logAroundOutputSchema.parse(
			await locateAround(socket(), { bootId, at, eventId: "event-id" }),
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.approximate).toBe(false);
		expect(result.anchor?.ts).toBe(at);
		expect(result.older.entries.map((row) => row.ts)).toEqual([0]);
		expect(result.newer.entries.map((row) => row.ts)).toEqual([1]);
	},
);
test("the empty maximum-timestamp newer window stays terminal when the older scan spends its budget", async () => {
	fixture.scan.mockImplementation(async (input) => {
		input.onRecord({ ...record(1), ts: max });
		return { status: "budget", exitCode: 143, skippedRecords: 0 };
	});
	const result = logAroundOutputSchema.parse(
		await locateAround(socket(), { bootId, at: max }),
	);
	expect(result).toMatchObject({
		ok: true,
		older: { hasMore: null, termination: "budget" },
		newer: {
			entries: [],
			hasMore: false,
			termination: "end",
			continuation: null,
			bootId,
			historyEpoch: 7,
		},
	});
	expect(fixture.scan).toHaveBeenCalledTimes(1);
});
