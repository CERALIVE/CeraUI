import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as timers from "node:timers";
import {
	type GroupProcessSnapshot,
	observePipeEof,
	type SnapshotClock,
	watchGroupProcess,
} from "./helpers/group-process-snapshot.ts";

const expected: GroupProcessSnapshot = {
	testName: "modelled\nnever-settling operation",
	phase: "collector-bound:50",
	pendingDelaysMs: [100, 50],
	pid: 2468,
	exitCode: 0,
	signalCode: null,
	stdoutEof: true,
	stderrEof: false,
	ownerId: "fixture-7:Symbol(helper:refresh)",
	ownerActive: true,
	isDisruptiveActionPending: true,
};

function clock() {
	let now = 0;
	const pending = new Map<() => void, number>();
	const schedule: SnapshotClock = (run) => {
		pending.set(run, now + 12);
		return () => {
			pending.delete(run);
		};
	};
	return {
		pending,
		schedule,
		advance: (ms: number) => {
			now += ms;
			for (const [run, due] of pending) {
				if (due <= now) {
					pending.delete(run);
					run();
				}
			}
		},
	};
}

const print = spyOn(console, "error").mockImplementation(() => undefined);
afterEach(() => print.mockClear());
afterAll(() => print.mockRestore());

test("prints exactly one current JSON snapshot when the operation never settles", () => {
	// Given an operation with no completion source and a controlled diagnostic clock.
	const time = clock();
	let state = { ...expected, phase: "before-command-deadline" };
	void watchGroupProcess(
		new Promise<never>(() => undefined),
		() => state,
		time.schedule,
	);
	time.advance(11);
	expect(print).not.toHaveBeenCalled();
	state = { ...expected };
	// When its diagnostic deadline passes, and then passes again.
	time.advance(1);
	time.advance(12);
	// Then the one stderr argument is a single JSON line containing the current fields.
	expect(print.mock.calls).toEqual([[JSON.stringify(expected)]]);
	expect(JSON.stringify(expected).split("\n")).toHaveLength(1);
});

test("preserves numeric Bun signal evidence in diagnostic snapshots", () => {
	const time = clock();
	const state = { ...expected, signalCode: 9 } satisfies GroupProcessSnapshot;
	void watchGroupProcess(
		new Promise<never>(() => undefined),
		() => state,
		time.schedule,
	);
	time.advance(12);
	expect(print.mock.calls).toEqual([[JSON.stringify(state)]]);
});

test("prints nothing and retires its timer when the operation resolves", async () => {
	// Given a pending operation and diagnostic timer.
	const time = clock();
	const operation = Promise.withResolvers<object>();
	const value = { completed: true };
	const work = watchGroupProcess(
		operation.promise,
		() => expected,
		time.schedule,
	);
	// When the original operation resolves before the deadline.
	operation.resolve(value);
	const result = await work;
	// Then the exact value survives, with no outstanding timer or later output.
	expect(result).toBe(value);
	expect(time.pending.size).toBe(0);
	time.advance(24);
	expect(print).not.toHaveBeenCalled();
});

test("prints nothing and retires its timer when the operation rejects", async () => {
	// Given an operation whose rejection has identity.
	const time = clock();
	const operation = Promise.withResolvers<never>();
	const error = new TypeError("modelled failure");
	const work = watchGroupProcess(
		operation.promise,
		() => expected,
		time.schedule,
	);
	const outcome = work.catch((cause: unknown) => cause);
	// When it rejects before the diagnostic deadline.
	operation.reject(error);
	// Then the rejection is unchanged and no diagnostic timer survives.
	expect(await outcome).toBe(error);
	expect(time.pending.size).toBe(0);
	time.advance(24);
	expect(print).not.toHaveBeenCalled();
});

test("keeps waiting for the original value after printing a snapshot", async () => {
	// Given an operation which outlives the diagnostic deadline.
	const time = clock();
	const operation = Promise.withResolvers<object>();
	const work = watchGroupProcess(
		operation.promise,
		() => expected,
		time.schedule,
	);
	let settled = false;
	void work.then(() => {
		settled = true;
	});
	time.advance(12);
	await Promise.resolve();
	expect(settled).toBe(false);
	// When the original operation eventually resolves.
	const value = { late: true };
	operation.resolve(value);
	// Then diagnostics neither replace the promise nor its outcome.
	expect(work).toBe(operation.promise);
	expect(await work).toBe(value);
	expect(print).toHaveBeenCalledTimes(1);
});

test("preserves the original rejection after printing a snapshot", async () => {
	// Given an operation still pending at the diagnostic deadline.
	const time = clock();
	const operation = Promise.withResolvers<never>();
	const error = new RangeError("late modelled failure");
	const work = watchGroupProcess(
		operation.promise,
		() => expected,
		time.schedule,
	);
	const outcome = work.catch((cause: unknown) => cause);
	time.advance(12);
	// When the operation eventually rejects.
	operation.reject(error);
	// Then exactly the original rejection survives the diagnostic.
	expect(await outcome).toBe(error);
	expect(print).toHaveBeenCalledTimes(1);
});

test("uses an unreferenced twelve-second timer on the native clock", async () => {
	// Given the native scheduler with only its returned timer observed.
	const timer = timers.setTimeout(() => undefined, 12000);
	const schedule = spyOn(timers, "setTimeout").mockReturnValue(timer);
	try {
		// When an ordinary operation is observed and settles immediately.
		const work = watchGroupProcess(Promise.resolve(42), () => expected);
		expect(schedule).toHaveBeenCalledTimes(1);
		expect(schedule.mock.calls[0]?.[1]).toBe(12000);
		expect(timer.hasRef()).toBe(false);
		// Then the original result remains available without diagnostic output.
		expect(await work).toBe(42);
		expect(print).not.toHaveBeenCalled();
	} finally {
		timers.clearTimeout(timer);
		schedule.mockRestore();
	}
});

test("observes pipe EOF without consuming or replacing output", async () => {
	// Given an already-closed pipe with unread output.
	const bytes = new Uint8Array([42]);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	const observation = observePipeEof(stream);
	try {
		const reader = stream.getReader();
		expect(observation.eof()).toBe(false);
		// When the actual consumer drains it.
		expect((await reader.read()).value).toBe(bytes);
		expect((await reader.read()).done).toBe(true);
		// Then closure is observed without changing the delivered bytes.
		expect(observation.eof()).toBe(true);
	} finally {
		observation.restore();
	}
});

test("does not report EOF when collection cancels an open pipe", async () => {
	// Given an open pipe without an EOF source.
	const stream = new ReadableStream<Uint8Array>();
	const observation = observePipeEof(stream);
	try {
		// When the collector cancels rather than reaching EOF.
		await stream.getReader().cancel();
		// Then cancellation is not positive EOF evidence.
		expect(observation.eof()).toBe(false);
	} finally {
		observation.restore();
	}
});
