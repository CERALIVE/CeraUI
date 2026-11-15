import { expect, spyOn, test } from "bun:test";
import {
	type JournalChild,
	JournalReadError,
	scanJournal,
} from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";

test("a synthesized errno without a present code property is not ENOENT", async () => {
	const failure = new Proxy(new Error("spawn failed"), {
		has(target, key) {
			return key === "code" ? false : Reflect.has(target, key);
		},
		get(target, key, receiver: unknown) {
			return key === "code" ? "ENOENT" : Reflect.get(target, key, receiver);
		},
	});
	await expect(
		scanJournal({
			...scanInput,
			spawn() {
				throw failure;
			},
		}),
	).rejects.toMatchObject({ code: "READ_FAILED", stderr: "" });
});

test.each(["budget", "abort"] as const)(
	"the first %s interruption survives later cancellation",
	async (first) => {
		const time = manualClock();
		const abort = new AbortController();
		const fake = fakeJournal([journalLine().repeat(2)], { held: true });
		let seen = 0;
		const result = await scanJournal({
			...scanInput,
			clock: time.clock,
			signal: abort.signal,
			spawn: () => fake.child,
			onRecord() {
				seen++;
				if (first === "budget") {
					time.advance(2000);
					abort.abort();
					return "stop";
				}
				abort.abort();
				time.advance(2000);
				return "continue";
			},
		});
		expect({
			result,
			seen,
			signals: fake.signals,
			timers: time.timers.size,
		}).toEqual({
			result: {
				status: first === "budget" ? "budget" : "stopped",
				exitCode: 143,
				skippedRecords: 0,
			},
			seen: 1,
			signals: ["SIGTERM"],
			timers: 0,
		});
	},
);

test("stdout exhaustion stays budget for an oversized buffered record", async () => {
	const fake = fakeJournal([`${"x".repeat(1024 * 1024 + 1)}\n`], {
		held: true,
	});
	const result = await scanJournal({
		...scanInput,
		limits: { stdoutBytes: 0 },
		spawn: () => fake.child,
	});
	expect({ result, signals: fake.signals }).toEqual({
		result: { status: "budget", exitCode: 143, skippedRecords: 0 },
		signals: ["SIGTERM"],
	});
});

test.each([-1, 0])(
	"a stderr cap of %d retains no diagnostic bytes",
	async (stderrBytes) => {
		const fake = fakeJournal([], { code: 1, stderr: "diagnostic" });
		await expect(
			scanJournal({
				...scanInput,
				limits: { stderrBytes },
				spawn: () => fake.child,
			}),
		).rejects.toMatchObject({ code: "READ_FAILED", stderr: "" });
	},
);

test("a malformed transport retains stderr captured before retirement", async () => {
	const fake = fakeJournal(["{\n"], {
		held: true,
		stderr: "captured diagnostic",
	});
	await expect(
		scanJournal({ ...scanInput, spawn: () => fake.child }),
	).rejects.toMatchObject({
		code: "READ_FAILED",
		stderr: "captured diagnostic",
	});
});

test("a consumer journal error keeps its identity and receives this scan's stderr", async () => {
	const fake = fakeJournal([journalLine()], {
		held: true,
		stderr: "captured diagnostic",
	});
	const failure = new JournalReadError("READ_FAILED", "prior diagnostic");
	const result = await scanJournal({
		...scanInput,
		spawn: () => fake.child,
		onRecord() {
			throw failure;
		},
	}).catch((error: unknown) => error);
	expect(result).toBe(failure);
	expect(failure.stderr).toBe("captured diagnostic");
});

test("completed scans release both pipe reader locks", async () => {
	const fake = fakeJournal([journalLine()]);
	await scanJournal({ ...scanInput, spawn: () => fake.child });
	expect({
		stdout: fake.child.stdout.locked,
		stderr: fake.child.stderr.locked,
	}).toEqual({ stdout: false, stderr: false });
});

test("stderr arriving after retirement starts cannot replace the captured diagnostic", async () => {
	const time = manualClock();
	const exit = Promise.withResolvers<number>();
	let dead = false;
	let released = false;
	let diagnostic: ReadableStreamDefaultController<Uint8Array>;
	const signals: string[] = [];
	const child: JournalChild = {
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(journalLine()));
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				diagnostic = controller;
			},
		}),
		exited: exit.promise,
		get exitCode() {
			return dead ? 143 : null;
		},
		get signalCode() {
			return dead ? "SIGTERM" : null;
		},
		kill(signal) {
			signals.push(signal);
		},
	};
	const result = await scanJournal({
		...scanInput,
		clock: {
			...time.clock,
			clearTimeout(timer) {
				time.clock.clearTimeout(timer);
				if (released) return;
				released = true;
				queueMicrotask(() => {
					diagnostic.enqueue(new TextEncoder().encode("late diagnostic"));
					diagnostic.close();
					exit.resolve(143);
				});
			},
		},
		spawn: () => child,
		onRecord() {
			dead = true;
			return "stop";
		},
	}).catch((error: unknown) => error);
	expect(result).toMatchObject({ code: "READ_FAILED", stderr: "" });
	expect(signals).toEqual([]);
});

test("the default clock enforces elapsed time and retires every allocated timer", async () => {
	const fake = fakeJournal([journalLine().repeat(2)], { held: true });
	let now = 10_000;
	let seen = 0;
	const active = new Set<number>();
	const delays: unknown[] = [];
	const allocate = globalThis.setTimeout;
	const retire = globalThis.clearTimeout;
	const monotonic = spyOn(performance, "now").mockImplementation(() => now);
	const scheduled = spyOn(globalThis, "setTimeout").mockImplementation(
		new Proxy(allocate, {
			apply(target, receiver: unknown, args: unknown[]) {
				const timer: ReturnType<typeof setTimeout> = Reflect.apply(
					target,
					receiver,
					args,
				);
				active.add(Number(timer));
				delays.push(args[1]);
				return timer;
			},
		}),
	);
	const cleared = spyOn(globalThis, "clearTimeout").mockImplementation(
		new Proxy(retire, {
			apply(target, receiver: unknown, args: unknown[]) {
				active.delete(Number(args[0]));
				return Reflect.apply(target, receiver, args);
			},
		}),
	);
	try {
		const result = await scanJournal({
			...scanInput,
			spawn: () => fake.child,
			onRecord() {
				now = 13_000;
				return ++seen === 2 ? "stop" : "continue";
			},
		});
		expect({ result, seen, delays, active: [...active] }).toEqual({
			result: { status: "budget", exitCode: 143, skippedRecords: 0 },
			seen: 1,
			delays: [2000, 100],
			active: [],
		});
	} finally {
		monotonic.mockRestore();
		scheduled.mockRestore();
		cleared.mockRestore();
		for (const timer of active) retire(timer);
	}
});
