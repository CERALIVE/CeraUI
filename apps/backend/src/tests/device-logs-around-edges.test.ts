import { afterEach, beforeEach, expect, test } from "bun:test";
import { locateAround } from "../modules/device-logs/query.ts";
import {
	bootId,
	eventMessage,
	journal,
	queryFixture,
	record,
	socket,
} from "./helpers/device-query.ts";

let fixture: ReturnType<typeof queryFixture>;
beforeEach(() => {
	fixture = queryFixture();
});
afterEach(() => fixture.restore());
test.each([1, 1000, 4999, 5001, 5999, 6001])(
	"seek at %i ms traverses without native realtime bounds",
	async (at) => {
		fixture.scan.mockImplementationOnce(async (input) => {
			expect(input.options).toEqual(["-r"]);
			expect(input.onRecord(record(at, { MESSAGE: eventMessage }))).toBe(
				"continue",
			);
			return { status: "eof", exitCode: 0, skippedRecords: 0 };
		});
		fixture.scan.mockImplementation(async () => {
			return { status: "eof", exitCode: 0, skippedRecords: 0 };
		});
		const result = await locateAround(socket(), {
			bootId,
			at,
			eventId: "event-id",
		});
		// The scripted continuation has no anchor, so its position honestly expires.
		expect(result).toEqual({ ok: false, error: "CURSOR_UNAVAILABLE" });
	},
);
test("timestamp zero remains a valid approximate range with the boundary only in the older page", async () => {
	fixture.scan.mockImplementation(
		journal([record(0), record(1), record(60_000), record(60_001)]),
	);
	const result = await locateAround(socket(), { bootId, at: 0 });
	if (!result.ok) throw new Error(result.error);
	expect(result.approximate).toBe(true);
	expect(result.older.entries.map((row) => row.ts)).toEqual([0]);
	expect(result.newer.entries.map((row) => row.ts)).toEqual([1, 60_000]);
	expect(result.olderQuery).toMatchObject({ until: 0 });
	expect(result.olderQuery.since).toBeUndefined();
});
test("an event outside the seek window cannot become an exact anchor", async () => {
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: eventMessage })]),
	);
	const result = await locateAround(socket(), {
		bootId,
		at: 100_000,
		eventId: "event-id",
	});
	expect(result).toMatchObject({ ok: true, approximate: true, anchor: null });
});
test.each([
	[0, 0, false],
	[10_000, 5000, false],
	[10_000, 15_000, false],
	[10_000, 4999, true],
	[10_000, 15_001, true],
] as const)(
	"event at %i ms and record at %i ms has approximate=%j",
	async (at, ts, approximate) => {
		fixture.scan.mockImplementation(
			journal([record(ts, { MESSAGE: eventMessage })]),
		);
		const result = await locateAround(socket(), {
			bootId,
			at,
			eventId: "event-id",
		});
		if (!result.ok) throw new Error(result.error);
		expect(result.approximate).toBe(approximate);
		expect(result.anchor?.ts ?? null).toBe(approximate ? null : ts);
	},
);
test("the first in-range exact match wins in reverse cursor order across a clock step", async () => {
	fixture.scan.mockImplementationOnce(async (input) => {
		return journal([
			record(1, { MESSAGE: eventMessage }),
			record(2, { MESSAGE: eventMessage }),
			record(20_000, { MESSAGE: eventMessage }),
		])(input);
	});
	fixture.scan.mockImplementation(journal([record(1), record(2), record(3)]));
	const result = await locateAround(socket(), {
		bootId,
		at: 2,
		eventId: "event-id",
	});
	expect(result).toMatchObject({
		ok: true,
		approximate: false,
		anchor: { cursor: "s=2" },
	});
});
test.each(["older", "newer"] as const)(
	"an expired %s position fails the entire location reply",
	async (direction) => {
		let call = 0;
		fixture.scan.mockImplementation(async (input) => {
			const page = call++ === 0 ? "seek" : call === 2 ? "older" : "newer";
			input.onRecord(
				record(page === direction ? 0 : 2, { MESSAGE: eventMessage }),
			);
			return { status: "eof", exitCode: 0, skippedRecords: 0 };
		});
		expect(
			await locateAround(socket(), { bootId, at: 2, eventId: "event-id" }),
		).toEqual({ ok: false, error: "CURSOR_UNAVAILABLE" });
		expect(fixture.scan).toHaveBeenCalledTimes(direction === "older" ? 2 : 3);
	},
);
test("a near-zero approximate range clamps its lower bound without dropping timestamp zero", async () => {
	fixture.scan.mockImplementation(journal([record(0), record(1), record(2)]));
	const result = await locateAround(socket(), { bootId, at: 1 });
	if (!result.ok) throw new Error(result.error);
	expect(result.older.entries.map((row) => row.ts)).toEqual([1, 0]);
	expect(result.newer.entries.map((row) => row.ts)).toEqual([2]);
	expect(result.olderQuery.since).toBe(0);
});
