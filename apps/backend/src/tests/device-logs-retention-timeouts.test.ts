import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { logger } from "../helpers/logger.ts";
import * as clearJournal from "../modules/device-logs/clear-journal.ts";
import * as follow from "../modules/device-logs/follow.ts";
import * as reader from "../modules/device-logs/reader.ts";
import {
	clearAll,
	deleteLegacyDebug,
	getStorage,
	queuedRetentionMutationsForTest,
	setRetention,
} from "../modules/device-logs/retention.ts";
import * as files from "../modules/device-logs/retention-files.ts";
import {
	getLogState,
	historyClearAwaitingSettlement,
	historyClearing,
} from "../modules/device-logs/settings.ts";
import { readOldestEntry } from "../modules/device-logs/storage.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { fakeJournal, manualClock } from "./helpers/device-journal.ts";
import { historyFixture, latch } from "./helpers/history-clear.ts";

const limits = { maxAgeDays: 7, maxSizeMb: 64, detail: "info" } as const;
const readFailed = { ok: false, error: "READ_FAILED" } as const;
const unknownOldest = { ts: null, known: false };
const realScan = reader.scanJournal;
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function replyOf<T>(promise: Promise<T>) {
	let reply: T | undefined;
	void promise.then((value) => {
		reply = value;
	});
	return () => reply;
}

function replyClock() {
	const time = manualClock();
	const schedule = spyOn(globalThis, "setTimeout").mockImplementation(
		new Proxy(globalThis.setTimeout, {
			apply(_target, _self, [callback, delay, ...args]) {
				return time.clock.setTimeout(() => callback(...args), delay);
			},
		}),
	);
	const cancel = spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
		time.clock.clearTimeout(Number(id));
	});
	return {
		async advance(ms: number) {
			time.advance(ms);
			await yieldTurn();
		},
		wait: (ms: number) =>
			new Promise<void>((resolve) => time.clock.setTimeout(resolve, ms)),
		restore() {
			cancel.mockRestore();
			schedule.mockRestore();
		},
	};
}

let h: ReturnType<typeof historyFixture>;
let time: ReturnType<typeof replyClock>;
beforeEach(() => {
	h = historyFixture(false);
	time = replyClock();
});
afterEach(async () => {
	time.restore();
	await h.dispose();
});

test("an expired queued clear replies BUSY before its predecessor releases and never runs", async () => {
	const vacuum = h.holdVacuum();
	const clear = spyOn(clearJournal, "clearNativeJournal");
	const predecessor = h.own(setRetention(limits));
	await yieldTurn();
	const pending = h.own(clearAll());
	const reply = replyOf(pending);
	try {
		await time.advance(9_999);
		expect(reply()).toBeUndefined();
		await time.advance(1);
		expect(reply()).toEqual({ ok: false, error: "BUSY" });
		vacuum.release();
		expect((await predecessor).ok).toBe(true);
		expect((await h.own(deleteLegacyDebug())).ok).toBe(true);
		expect(clear).not.toHaveBeenCalled();
	} finally {
		vacuum.release();
		await Promise.all([predecessor, pending]);
		clear.mockRestore();
	}
});

test("every command on the storage and cleanup reply paths gets an explicit finite timeout", async () => {
	h.list.mockRestore();
	await getStorage();
	expect((await setRetention(limits)).ok).toBe(true);
	expect((await deleteLegacyDebug()).ok).toBe(true);
	expect((await clearAll()).ok).toBe(true);
	const commands = h.f.run.mock.calls.map(([, args, options]) => [
		args[0],
		options?.timeout,
	]);
	expect(commands).toEqual(
		[
			"--disk-usage",
			"--vacuum-time=7d",
			"--disk-usage",
			"--disk-usage",
			"--disk-usage",
			"--list-boots",
			"--rotate",
			"--vacuum-time=1s",
			"--list-boots",
			"--disk-usage",
		].map((command) => [command, 30_000]),
	);
});

test("an unreaped readout child degrades storage without allowing another child to spawn", async () => {
	const child = fakeJournal([], { held: true });
	const kill = spyOn(child.child, "kill").mockImplementation(() => {});
	const spawn = () => child.child;
	const normal = h.scan.getMockImplementation();
	if (!normal) throw new Error("missing reader fixture");
	const scans: Promise<reader.JournalScanResult>[] = [];
	const stats = spyOn(files, "legacyDebugBytes").mockResolvedValue(0);
	h.scan.mockImplementationOnce((input) => {
		const pending = realScan({ ...input, spawn });
		scans.push(pending);
		return pending;
	});
	const first = h.own(getStorage());
	const readout = replyOf(first);
	await yieldTurn();
	const concurrent = h.own(readOldestEntry());
	const second = replyOf(concurrent);
	try {
		await yieldTurn();
		expect(second()).toEqual(unknownOldest);
		expect(h.scan).toHaveBeenCalledTimes(1);
		await time.advance(2_000);
		await time.advance(100);
		expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		await time.advance(999);
		expect(readout()).toBeUndefined();
		await time.advance(1);
		expect(readout()).toMatchObject({
			oldestEntryTs: null,
			recentVolume: [],
			recentSample: 0,
		});
		expect(await readOldestEntry()).toEqual(unknownOldest);
		expect(h.scan).toHaveBeenCalledTimes(1);
		child.finish(137, "SIGKILL");
		await Promise.allSettled(scans);
		await yieldTurn();
		expect(await readOldestEntry()).toEqual({
			ts: expect.any(Number),
			known: true,
		});
		expect(h.scan).toHaveBeenCalledTimes(2);
	} finally {
		child.finish(137, "SIGKILL");
		await Promise.allSettled([first, concurrent, ...scans]);
		kill.mockRestore();
		stats.mockRestore();
	}
});

test("a hung journal directory walk and legacy stat degrade only their storage readings", async () => {
	const walk = h.ownedLatch();
	const stat = h.ownedLatch();
	h.directory.mockRestore();
	const readdir = spyOn(fs, "readdir").mockImplementationOnce(async () => {
		await walk.hold();
		return [];
	});
	const baseStat = fs.stat;
	const statFile = spyOn(fs, "stat").mockImplementationOnce(
		new Proxy(baseStat, {
			async apply(target, self, args) {
				await stat.hold();
				return Reflect.apply(target, self, args);
			},
		}),
	);
	const pending = h.own(getStorage());
	const reply = replyOf(pending);
	try {
		await yieldTurn();
		expect(readdir).toHaveBeenCalledWith("/var/log/journal", {
			withFileTypes: true,
		});
		await time.advance(3_100);
		expect(statFile).toHaveBeenCalledTimes(1);
		await time.advance(3_100);
		expect(reply()).toMatchObject({
			journalDirBytes: null,
			legacyDebugBytes: null,
		});
	} finally {
		walk.release();
		stat.release();
		await pending;
		readdir.mockRestore();
		statFile.mockRestore();
	}
});

test("timed-out legacy deletion fails its reply but keeps the queue until unlink settles", async () => {
	const hold = h.ownedLatch();
	const unlink = spyOn(fs, "unlink").mockImplementationOnce(hold.hold);
	const pending = h.own(deleteLegacyDebug());
	const reply = replyOf(pending);
	await yieldTurn();
	const next = h.own(setRetention(limits));
	const nextReply = replyOf(next);
	try {
		expect(unlink).toHaveBeenCalledTimes(1);
		await time.advance(3_100);
		expect(reply()).toEqual(readFailed);
		expect(nextReply()).toBeUndefined();
		expect(h.f.run).not.toHaveBeenCalled();
		hold.release();
		expect((await next).ok).toBe(true);
	} finally {
		hold.release();
		await Promise.all([pending, next]);
		unlink.mockRestore();
	}
});

test("expired admissions release all three queued entries before a held unlink settles, and later live requests run FIFO", async () => {
	const unlink = h.holdUnlink();
	const deleting = h.own(deleteLegacyDebug());
	try {
		await unlink.entered;
		await time.advance(3_100);
		expect(await deleting).toEqual(readFailed);

		const expired = Array.from({ length: 3 }, () => replyOf(h.own(clearAll())));
		expect(queuedRetentionMutationsForTest()).toBe(3);
		await time.advance(10_000);
		for (const reply of expired)
			expect(reply()).toEqual({ ok: false, error: "BUSY" });
		expect(queuedRetentionMutationsForTest()).toBe(0);

		const laterLimits = { ...limits, maxAgeDays: 14 };
		const first = h.own(setRetention(limits));
		const second = h.own(setRetention(laterLimits));
		expect(queuedRetentionMutationsForTest()).toBe(2);
		unlink.release();
		expect(await first).toMatchObject({
			ok: true,
			storage: { retention: limits },
		});
		expect(await second).toMatchObject({
			ok: true,
			storage: { retention: laterLimits },
		});
		expect((await getStorage()).retention).toEqual(laterLimits);
		expect(getLogState().historyEpoch).toBe(0);
	} finally {
		unlink.release();
	}
});

test.each(["journal", "unlink"] as const)(
	"Clear all keeps both fences when %s settles before the other pending operation",
	async (first) => {
		const hold = h.ownedLatch();
		const journalExit = Promise.withResolvers<void>();
		const clear = spyOn(
			clearJournal,
			"clearNativeJournal",
		).mockImplementationOnce((retain) => {
			retain(journalExit.promise);
			return Promise.resolve();
		});
		const unlink = spyOn(fs, "unlink").mockImplementationOnce(hold.hold);
		const marker = spyOn(logger, "info");
		const settling = h.own(clearAll());
		const reply = replyOf(settling);
		const firstRelease =
			first === "journal" ? journalExit.resolve : hold.release;
		const lastRelease =
			first === "journal" ? hold.release : journalExit.resolve;
		await yieldTurn();
		const next = h.own(setRetention(limits));
		const nextReply = replyOf(next);
		try {
			expect(unlink).toHaveBeenCalledTimes(1);
			await time.advance(3_100);
			expect(reply()).toEqual(readFailed);
			expect(getLogState().lastClearedAt).toBeNull();
			expect(marker).not.toHaveBeenCalledWith(
				"device logs cleared",
				expect.anything(),
			);
			expect(historyClearAwaitingSettlement()).toBe(true);
			expect(isDisruptiveActionPending()).toBe(true);
			firstRelease();
			await yieldTurn();
			expect(historyClearing()).not.toBeNull();
			expect(isDisruptiveActionPending()).toBe(true);
			expect(nextReply()).toBeUndefined();
			lastRelease();
			expect((await next).ok).toBe(true);
			expect(historyClearing()).toBeNull();
			expect(isDisruptiveActionPending()).toBe(false);
		} finally {
			hold.release();
			journalExit.resolve();
			await Promise.all([settling, next]);
			clear.mockRestore();
			unlink.mockRestore();
			marker.mockRestore();
		}
	},
);

test("Clear all replies inside its client budget with cumulative device-side delays", async () => {
	h.list.mockRestore();
	const drain = latch();
	const legacyStat = latch();
	const walk = latch();
	const predecessorRead = latch();
	const normal = h.f.run.getMockImplementation();
	const normalScan = h.scan.getMockImplementation();
	if (!normal) throw new Error("missing command fixture");
	if (!normalScan) throw new Error("missing scan fixture");
	let clearingStarted = false;
	h.f.run.mockImplementation(async (bin, args, options) => {
		if (clearingStarted)
			await time.wait(args[0] === "--rotate" ? 30_000 : 30_250);
		return normal(bin, args, options);
	});
	h.scan.mockImplementation(async (input) => {
		if (clearingStarted) await time.wait(3_099);
		return normalScan(input);
	});
	const stop = spyOn(follow, "stopAllFollows").mockImplementationOnce(() => {
		clearingStarted = true;
		return drain.hold();
	});
	h.directory.mockImplementation(async () => {
		if (clearingStarted) await walk.hold();
		return 41;
	});
	const remove = spyOn(files, "deleteLegacyDebugFiles").mockImplementation(() =>
		time.wait(3_099),
	);
	const stats = spyOn(files, "legacyDebugBytes").mockImplementation(
		async () => {
			await (clearingStarted ? legacyStat : predecessorRead).hold();
			return 7;
		},
	);
	// Just under the queue bound: two consecutive predecessor stages.
	h.f.run.mockImplementationOnce(async () => {
		await time.wait(7_000);
		return "take up 1M";
	});
	const initial = h.own(
		setRetention({ ...limits, maxAgeDays: null, maxSizeMb: null }),
	);
	await yieldTurn();
	const clearing = h.own(clearAll());
	const reply = replyOf(clearing);
	try {
		await time.advance(7_000);
		await predecessorRead.entered;
		await time.advance(2_999);
		predecessorRead.release();
		await yieldTurn();
		await drain.entered;
		await time.advance(14_999);
		drain.release();
		await yieldTurn();
		for (const delay of [
			30_250, 30_000, 30_250, 3_099, 30_250, 30_250, 3_099, 3_099,
		])
			await time.advance(delay);
		await walk.entered;
		await time.advance(3_100);
		await time.advance(3_100);
		// Elapsed 191,495ms, with both filesystem readouts still hung.
		expect(reply()).toMatchObject({
			ok: true,
			storage: { journalDirBytes: null, legacyDebugBytes: null },
		});
	} finally {
		predecessorRead.release();
		drain.release();
		walk.release();
		legacyStat.release();
		// Drain all injected timers even on the unbounded base.
		for (let step = 0; step < 10; ++step) await time.advance(31_000);
		await Promise.all([initial, clearing]);
		stop.mockRestore();
		stats.mockRestore();
		remove.mockRestore();
	}
});
