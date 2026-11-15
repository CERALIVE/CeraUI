import { afterEach, beforeEach, expect, test } from "bun:test";
import { logAroundOutputSchema } from "@ceraui/rpc/schemas";
import { locateAround, queryLogs } from "../modules/device-logs/query.ts";
import {
	bootId,
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
test("an event anchor is excluded from two resumable surrounding pages", async () => {
	const rows = Array.from({ length: 120 }, (_, n) =>
		record(n, { MESSAGE: n === 60 ? "event-id" : `row ${n}` }),
	);
	fixture.scan.mockImplementationOnce(async (input) => {
		expect(input.options).toEqual(["--since=@0", "--until=@6"]);
		expect(input.matches).toContain("_SYSTEMD_UNIT=ceralive.service");
		for (const row of rows) if (input.onRecord(row) === "stop") break;
		return { status: "stopped", exitCode: 143, skippedRecords: 0 };
	});
	fixture.scan.mockImplementation(journal(rows));
	const conn = socket();
	const result = await locateAround(conn, {
		bootId,
		at: 60,
		eventId: "event-id",
	});
	expect(logAroundOutputSchema.safeParse(result).success).toBe(true);
	if (!result.ok) throw new Error(result.error);
	expect(result.approximate).toBe(false);
	expect(result.anchor?.cursor).toBe("s=60");
	expect(result.older.entries.map((r) => r.ts)).toEqual(
		Array.from({ length: 50 }, (_, i) => 59 - i),
	);
	expect(result.newer.entries.map((r) => r.ts)).toEqual(
		Array.from({ length: 50 }, (_, i) => 61 + i),
	);
	for (const direction of ["older", "newer"] as const) {
		const next = await queryLogs(conn, {
			...result[`${direction}Query`],
			continuation: result[direction].continuation ?? undefined,
		});
		expect(next.ok).toBe(true);
	}
});
test.each([undefined, "absent"] as const)(
	"approximate pages for %s have strict non-overlapping time membership",
	async (eventId) => {
		const rows = [
			39_999, 40_000, 99_999, 100_000, 100_001, 160_000, 160_001,
		].map((n) => record(n));
		fixture.scan.mockImplementation(journal(rows));
		const result = await locateAround(socket(), {
			bootId,
			at: 100_000,
			eventId,
		});
		expect(logAroundOutputSchema.safeParse(result).success).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result).toMatchObject({ anchor: null, approximate: true });
		expect(result.older.entries.map((r) => r.ts)).toEqual([
			100_000, 99_999, 40_000,
		]);
		expect(result.newer.entries.map((r) => r.ts)).toEqual([100_001, 160_000]);
		expect(result.olderQuery).toMatchObject({
			sources: [],
			limit: 50,
			since: 40_000,
			until: 100_000,
			direction: "older",
		});
		expect(result.newerQuery).toMatchObject({
			sources: [],
			limit: 50,
			since: 100_001,
			until: 160_000,
			direction: "newer",
		});
	},
);
test("unknown boots fail before seeking an event", async () => {
	fixture.list.mockResolvedValue([]);
	expect(await locateAround(socket(), { bootId, at: 1, eventId: "x" })).toEqual(
		{ ok: false, error: "BOOT_UNAVAILABLE" },
	);
	expect(fixture.scan).not.toHaveBeenCalled();
});
test("stored-only boots cannot anchor a raw event location", async () => {
	const rows = await fixture.list();
	fixture.list.mockResolvedValue(
		rows.map((row) => ({ ...row, logsAvailable: false })),
	);
	expect(await locateAround(socket(), { bootId, at: 1 })).toEqual({
		ok: false,
		error: "BOOT_UNAVAILABLE",
	});
	expect(fixture.scan).not.toHaveBeenCalled();
});
test("seek and surrounding page errors are never partial successes", async () => {
	fixture.scan.mockRejectedValue(
		new (await import("../modules/device-logs/reader.ts")).JournalReadError(
			"READ_FAILED",
		),
	);
	expect(await locateAround(socket(), { bootId, at: 1, eventId: "x" })).toEqual(
		{ ok: false, error: "READ_FAILED" },
	);
});
test("exact surrounding pages retain adjacent records outside approximate clock windows", async () => {
	fixture.scan.mockImplementation(
		journal([
			record(1, { __REALTIME_TIMESTAMP: "0" }),
			record(2, { __REALTIME_TIMESTAMP: "100000000", MESSAGE: "event-id" }),
			record(3, { __REALTIME_TIMESTAMP: "200000000" }),
		]),
	);
	const result = await locateAround(socket(), {
		bootId,
		at: 100_000,
		eventId: "event-id",
	});
	if (!result.ok) throw new Error(result.error);
	expect(result.approximate).toBe(false);
	expect(result.older.entries.map((row) => row.ts)).toEqual([0]);
	expect(result.newer.entries.map((row) => row.ts)).toEqual([200_000]);
	expect(result.olderQuery.since).toBeUndefined();
	expect(result.olderQuery.until).toBeUndefined();
	expect(result.newerQuery.since).toBeUndefined();
	expect(result.newerQuery.until).toBeUndefined();
});
