import { expect, test } from "bun:test";
import type { LogFilter } from "@ceraui/rpc/schemas";
import type { FollowBatch } from "../modules/device-logs/follow-batch.ts";
import { createFollowDelivery } from "../modules/device-logs/follow-delivery.ts";
import { manualClock } from "./helpers/device-journal.ts";
import { record } from "./helpers/device-query.ts";

function delivery(filter: LogFilter = {}, cursor: string | null = "s=1") {
	const time = manualClock();
	const controller = new AbortController();
	const batches: FollowBatch[] = [];
	let aborts = 0;
	const state = createFollowDelivery({
		filter,
		cursor,
		clock: time.clock,
		signal: controller.signal,
		send: (batch) => {
			batches.push(batch);
		},
		abort: () => {
			aborts++;
			controller.abort();
		},
	});
	return { time, controller, batches, state, aborts: () => aborts };
}
test("the inclusive anchor is dropped only in the first-record position", () => {
	const f = delivery();
	expect(f.state.onRecord(record(1))).toBe("continue");
	expect(f.time.timers.size).toBe(0);
	expect(f.state.onRecord(record(2))).toBe("continue");
	expect(f.state.onRecord(record(1))).toBe("continue");
	f.time.advance(250);
	expect(f.batches.map((b) => b.entries.map((e) => e.cursor))).toEqual([
		["s=2", "s=1"],
	]);
	expect(f.state.batch.entries).toEqual([]);
	expect(f.state.batch.checkpointCursor).toBe("s=1");
});
test("no residual match means no timer, while the examined position advances", () => {
	const f = delivery({ text: "needle" });
	expect(f.state.onRecord(record(2))).toBe("continue");
	expect(f.state.batch.checkpointCursor).toBe("s=2");
	expect(f.state.batch.entries).toEqual([]);
	expect(f.time.timers.size).toBe(0);
});
test("exactly 2000 catchup records stay bounded and only preflush overflow restarts", () => {
	const f = delivery();
	for (let n = 2; n <= 2001; n++)
		expect(f.state.onRecord(record(n))).toBe("continue");
	expect(f.state.restart).toBe(false);
	expect(f.state.batch.dropped).toBe(1800);
	expect(f.time.timers.size).toBe(1);
	f.time.advance(0);
	expect(f.batches[0]?.entries.length).toBe(200);
	expect(f.state.batch.dropped).toBe(0);
	for (let n = 2002; n <= 4003; n++)
		expect(f.state.onRecord(record(n))).toBe("continue");
	expect(f.state.restart).toBe(false);
	expect(f.aborts()).toBe(0);
	f.state.cancel();
});
test("record 2001 before the first flush requests one restart and stops late callbacks", () => {
	const f = delivery();
	for (let n = 2; n <= 2001; n++) f.state.onRecord(record(n));
	expect(f.state.onRecord(record(2002))).toBe("stop");
	expect(f.state.restart).toBe(true);
	expect(f.aborts()).toBe(1);
	expect(f.state.onRecord(record(2003))).toBe("stop");
	expect(f.aborts()).toBe(1);
	f.state.cancel();
	expect(f.time.timers.size).toBe(0);
});
test("batch pressure advances one timer without postponing it on later entries", () => {
	const f = delivery({}, null);
	for (let n = 1; n <= 200; n++) f.state.onRecord(record(n));
	const before = [...f.time.timers];
	f.state.onRecord(record(201));
	expect([...f.time.timers]).toEqual(before);
	f.time.advance(0);
	expect(f.batches[0]?.dropped).toBe(1);
	expect(f.time.timers.size).toBe(0);
});
test("cancel discards the pending timer and is idempotent", () => {
	const f = delivery();
	f.state.onRecord(record(2));
	f.state.cancel();
	f.state.cancel();
	f.time.advance(1000);
	expect(f.batches).toEqual([]);
	expect(f.time.timers.size).toBe(0);
});
