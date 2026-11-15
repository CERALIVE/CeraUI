import { expect, test } from "bun:test";
import {
	appendFollowRecord,
	emptyFollowBatch,
	followFlushDelay,
} from "../modules/device-logs/follow-batch.ts";
import { toLogEntry } from "../modules/device-logs/parse.ts";
import { record } from "./helpers/device-query.ts";

test("rejected residuals advance only the examined checkpoint", () => {
	const batch = appendFollowRecord(emptyFollowBatch("s=0"), record(1), false);
	expect(batch).toEqual({
		entries: [],
		checkpointCursor: "s=1",
		dropped: 0,
		bytes: 0,
	});
});
test("wire batches strip classifier fields and count serialized UTF-8 bytes", () => {
	const row = record(1, { MESSAGE: "é" });
	const batch = appendFollowRecord(emptyFollowBatch(null), row, true);
	expect(batch).toEqual({
		entries: [toLogEntry(row)],
		checkpointCursor: "s=1",
		dropped: 0,
		bytes: new TextEncoder().encode(JSON.stringify(toLogEntry(row))).byteLength,
	});
	expect(followFlushDelay(batch)).toBe(250);
});
test("suppression marks a kept batch and remains marked across ordinary records", () => {
	const row = record(1, { MESSAGE_ID: "a596d6fe7bfa4994828e72309e95d61e" });
	const batch = appendFollowRecord(emptyFollowBatch(null), row, true);
	expect(appendFollowRecord(batch, record(2), true).gap).toBe("suppressed");
	expect(
		appendFollowRecord(emptyFollowBatch(null), row, false).gap,
	).toBeUndefined();
});
test.each([199, 200, 201])(
	"entry pressure boundary %i bounds the pending batch",
	(count) => {
		const batch = {
			...emptyFollowBatch(null),
			entries: Array.from({ length: count }, (_, i) => toLogEntry(record(i))),
		};
		const next = appendFollowRecord(batch, record(300), true);
		expect(next.entries.length).toBe(count < 200 ? count + 1 : count);
		expect(next.dropped).toBe(count < 200 ? 0 : 1);
		expect(next.checkpointCursor).toBe("s=300");
		expect(followFlushDelay(batch)).toBe(count < 200 ? 250 : 0);
	},
);
test.each([-1, 0, 1])(
	"byte pressure boundary %+i allows exactly 256 KiB",
	(offset) => {
		const row = record(2);
		const bytes = new TextEncoder().encode(
			JSON.stringify(toLogEntry(row)),
		).byteLength;
		const batch = {
			...emptyFollowBatch("s=1"),
			bytes: 256 * 1024 - bytes + offset,
			dropped: 3,
		};
		const next = appendFollowRecord(batch, row, true);
		expect(next.entries).toEqual(offset > 0 ? [] : [toLogEntry(row)]);
		expect(next.dropped).toBe(offset > 0 ? 4 : 3);
		expect(next.bytes).toBe(offset > 0 ? batch.bytes : 256 * 1024 + offset);
	},
);
test.each([65535, 65536, 65537])(
	"byte flush boundary %i schedules early at 64 KiB",
	(bytes) => {
		expect(followFlushDelay({ ...emptyFollowBatch(null), bytes })).toBe(
			bytes < 65536 ? 250 : 0,
		);
	},
);
