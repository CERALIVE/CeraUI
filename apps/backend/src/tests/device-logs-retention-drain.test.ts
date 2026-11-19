import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogFollowMessage, LogStorageOutput } from "@ceraui/rpc/schemas";
import { getRecentLogLines } from "../helpers/logger.ts";
import * as exportOwner from "../modules/device-logs/export.ts";
import { createExport } from "../modules/device-logs/export.ts";
import { startFollow } from "../modules/device-logs/follow.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import { withQuerySlot } from "../modules/device-logs/query-admission.ts";
import { clearAll } from "../modules/device-logs/retention.ts";
import { getLogState } from "../modules/device-logs/settings.ts";
import { bounded, historyFixture, turn } from "./helpers/history-clear.ts";
import { drainClock } from "./helpers/history-drain-clock.ts";
import { historyJournal } from "./helpers/history-journal.ts";

const abortExports = exportOwner.abortLogExports;
let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	await h?.dispose();
});

test("a real nonsettling query owner fails clear at 15 seconds without deletion or a stuck door", async () => {
	h = historyFixture(true);
	const release = h.ownedLatch();
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const query = h.own(
		withQuerySlot({}, async (signal) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			entered.resolve();
			await release.hold();
			return "old owner";
		}).then(
			(value) => value,
			(error: unknown) => error,
		),
	);
	await bounded(entered.promise);
	writeFileSync(join(h.f.dir, "debug.log"), "keep evidence");
	const before = getRecentLogLines();
	const clock = drainClock();
	let result: LogStorageOutput | undefined;
	const clearing = h.own(
		clearAll().then((value) => {
			result = value;
			return value;
		}),
	);
	try {
		await bounded(aborted.promise);
		clock.capture();
		clock.advance(14_999);
		await turn();
		expect(result).toBeUndefined();
		clock.advance(1);
		expect(await bounded(clearing)).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
		expect(clock.wasCleared()).toBe(true);
		expect(getLogState().historyEpoch).toBe(1);
		expect(getLogState().lastClearedAt).toBeNull();
		expect(getRecentLogLines()).toEqual(before);
		expect(readFileSync(join(h.f.dir, "debug.log"), "utf8")).toBe(
			"keep evidence",
		);
		expect((await bounded(createExport({}, { filter: {} }))).ok).toBe(true);
		expect((await bounded(queryLogs({}, {}))).ok).toBe(true);
	} finally {
		release.release();
		await bounded(Promise.allSettled([clearing, query]));
		clock.dispose();
	}
});

test("a reaped follower with a frozen stream cancel hook releases its slot and allows clear", async () => {
	h = historyFixture(false);
	const hook = Promise.withResolvers<void>();
	const process = historyJournal({
		mode: "follow-cancel-hook",
		cancel: hook.promise,
	});
	const messages: LogFollowMessage[] = [];
	const conn = h.socket(messages);
	expect(
		(
			await startFollow(
				conn,
				{},
				{ clock: h.time.clock, spawn: () => process.proc },
			)
		).ok,
	).toBe(true);
	const evidence = join(h.f.dir, "debug.log");
	writeFileSync(evidence, "native evidence");
	const clearing = h.own(clearAll());
	try {
		await bounded(process.cancelled);
		expect((await bounded(clearing)).ok).toBe(true);
		expect(h.f.run.mock.calls.slice(0, 2)).toEqual([
			["journalctl", ["--rotate"]],
			["journalctl", ["--vacuum-time=1s"]],
		]);
		expect(getLogState().historyEpoch).toBe(1);
		expect(getLogState().lastClearedAt).not.toBeNull();
		expect(existsSync(evidence)).toBe(false);
		expect(process.alive).toBe(false);
		expect(process.cancelCount).toBe(1);
		expect(process.proc.stdout.locked).toBe(false);
		expect(process.proc.stderr.locked).toBe(false);
		expect((await h.start(conn)).result.ok).toBe(true);
		expect((await bounded(clearAll())).ok).toBe(true);
		expect(messages.map((message) => message.ended)).toEqual([
			"cleared",
			"cleared",
		]);
		expect(getLogState().historyEpoch).toBe(2);
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
	} finally {
		hook.resolve();
		process.finish();
		await bounded(clearing);
	}
});

test("nonsettling real reader stream-cancel hooks do not block a successful clear", async () => {
	h = historyFixture(true);
	const hook = Promise.withResolvers<void>();
	const process = historyJournal({
		mode: "reader-cancel-hooks",
		cancel: hook.promise,
	});
	const entered = Promise.withResolvers<void>();
	const nativeScan = (await import("../modules/device-logs/reader.ts"))
		.scanJournal;
	const baseline = h.scan.getMockImplementation();
	if (!baseline) throw new Error("missing transport");
	h.scan.mockImplementationOnce((input) => {
		entered.resolve();
		return nativeScan({ ...input, spawn: () => process.proc });
	});
	const query = h.own(
		(await import("../modules/device-logs/query.ts")).queryLogs({}, {}),
	);
	await bounded(entered.promise);
	const clearing = h.own(clearAll());
	try {
		expect((await bounded(clearing)).ok).toBe(true);
		expect(await bounded(query)).toEqual({ ok: false, error: "READ_FAILED" });
		expect(process.cancelCount).toBe(2);
		expect((await bounded(createExport({}, { filter: {} }))).ok).toBe(true);
	} finally {
		hook.resolve();
		process.finish();
	}
});

test("a rejected cancellation waits for sibling drains before reopening with READ_FAILED", async () => {
	h = historyFixture(true);
	const held = await h.holdFollow();
	const failed = Promise.withResolvers<void>();
	const cancellation = spyOn(
		exportOwner,
		"abortLogExports",
	).mockImplementationOnce(async () => {
		await abortExports();
		failed.resolve();
		throw new Error("export cancellation consumer failed");
	});
	let result: LogStorageOutput | undefined;
	const clearing = h.own(
		clearAll().then((value) => {
			result = value;
			return value;
		}),
	);
	try {
		await bounded(held.gate.entered);
		await bounded(failed.promise);
		let admitted = false;
		const incoming = h.own(
			createExport({}, { filter: {} }).then((value) => {
				admitted = true;
				return value;
			}),
		);
		await turn();
		expect(result).toBeUndefined();
		expect(admitted).toBe(false);
		held.gate.release();
		expect(await bounded(clearing)).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
		expect((await bounded(incoming)).ok).toBe(true);
		expect(getLogState().lastClearedAt).toBeNull();
		expect(
			getRecentLogLines().some((line) => line.includes("before-clear")),
		).toBe(true);
		expect((await bounded(clearAll())).ok).toBe(true);
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
	} finally {
		held.gate.release();
		await bounded(clearing);
		cancellation.mockRestore();
	}
});
