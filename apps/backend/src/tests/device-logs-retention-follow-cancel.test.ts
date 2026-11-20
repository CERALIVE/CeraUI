import { afterEach, expect, spyOn, test } from "bun:test";
import { startFollow } from "../modules/device-logs/follow.ts";
import { clearAll } from "../modules/device-logs/retention.ts";
import { journalLine } from "./helpers/device-journal.ts";
import { bootId } from "./helpers/device-query.ts";
import { bounded, historyFixture } from "./helpers/history-clear.ts";
import { drainClock } from "./helpers/history-drain-clock.ts";
import { historyJournal } from "./helpers/history-journal.ts";

let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	await h?.dispose();
});

test("clear cancels the pending follow timer before a frozen stream-cancel hook can stall its join", async () => {
	h = historyFixture(false);
	const hook = Promise.withResolvers<void>();
	const process = historyJournal({
		mode: "follow-cancel-hook",
		cancel: hook.promise,
	});
	const timerEntered = Promise.withResolvers<void>();
	const schedule = h.time.clock.setTimeout;
	const scheduled = spyOn(h.time.clock, "setTimeout").mockImplementation(
		(callback, delay) => {
			const id = schedule(callback, delay);
			timerEntered.resolve();
			return id;
		},
	);
	const started = await startFollow(
		h.socket(),
		{},
		{ clock: h.time.clock, spawn: () => process.proc },
	);
	if (!started.ok) throw new Error(started.error);
	await bounded(
		process.emit(
			journalLine({
				__CURSOR: "s=pending",
				_BOOT_ID: bootId,
				MESSAGE: "pending batch",
				__REALTIME_TIMESTAMP: String(Date.now() * 1000),
			}),
		),
	);
	await bounded(timerEntered.promise);
	expect(h.time.timers.size).toBe(1);
	const clock = drainClock();
	const clearing = h.own(clearAll());
	try {
		await bounded(process.cancelled);
		expect(h.time.timers.size).toBe(0);
		clock.capture();
		clock.advance(15_000);
		expect(await bounded(clearing)).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
		expect(h.f.run.mock.calls).toEqual([]);
	} finally {
		hook.resolve();
		process.finish();
		await bounded(clearing);
		scheduled.mockRestore();
		clock.dispose();
	}
});
