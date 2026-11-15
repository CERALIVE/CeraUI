import { expect, test } from "bun:test";
import { scanJournal } from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";

test("4097 candidates consume only 4096 then report budget", async () => {
	const fake = fakeJournal([journalLine().repeat(4097)], { held: true });
	let seen = 0;
	expect(
		await scanJournal({
			...scanInput,
			spawn: () => fake.child,
			onRecord() {
				seen++;
				return "continue";
			},
		}),
	).toMatchObject({ status: "budget" });
	expect(seen).toBe(4096);
	expect(fake.signals).toEqual(["SIGTERM"]);
});

test("skipped records also spend the candidate budget", async () => {
	const fake = fakeJournal(["{}\n".repeat(4097)], { held: true });
	expect(
		await scanJournal({ ...scanInput, spawn: () => fake.child }),
	).toMatchObject({
		status: "budget",
		skippedRecords: 4096,
	});
});

test("exact candidate budget plus true EOF is still EOF", async () => {
	const fake = fakeJournal([journalLine().repeat(4096)]);
	expect(
		await scanJournal({ ...scanInput, spawn: () => fake.child }),
	).toMatchObject({ status: "eof" });
});

test.each([true, false])(
	"one MiB plus one byte record fails, newline=%s",
	async (newline) => {
		const fake = fakeJournal(
			["x".repeat(1024 * 1024 + 1) + (newline ? "\n" : "")],
			{ held: true },
		);
		await expect(
			scanJournal({ ...scanInput, spawn: () => fake.child }),
		).rejects.toMatchObject({ code: "RECORD_TOO_LARGE" });
		expect(fake.signals).toEqual(["SIGTERM"]);
	},
);

test("exact one MiB record is accepted across chunks", async () => {
	const overhead =
		new TextEncoder().encode(journalLine({ MESSAGE: "" })).length - 1;
	const line = journalLine({ MESSAGE: "x".repeat(1024 * 1024 - overhead) });
	const fake = fakeJournal([line.slice(0, 50), line.slice(50, -1), "\n"]);
	let length = 0;
	expect(
		await scanJournal({
			...scanInput,
			spawn: () => fake.child,
			onRecord(record) {
				length = record.message.length;
				return "continue";
			},
		}),
	).toMatchObject({ status: "eof" });
	expect(length).toBe(16_384);
});

test("stdout cap is eight MiB of bytes, independently of candidate count", async () => {
	const chunk = journalLine({ MESSAGE: "é".repeat(200_000) });
	const fake = fakeJournal(Array(22).fill(chunk), { held: true });
	let seen = 0;
	expect(
		await scanJournal({
			...scanInput,
			spawn: () => fake.child,
			onRecord() {
				seen++;
				return "continue";
			},
		}),
	).toMatchObject({ status: "budget" });
	expect(seen).toBe(20);
});

test("stderr captures only the first 64 KiB and still drains the pipe", async () => {
	const fake = fakeJournal([], { code: 1, stderr: "a".repeat(65_537) });
	const error = await scanJournal({
		...scanInput,
		spawn: () => fake.child,
	}).catch((error: unknown) => error);
	expect(error).toMatchObject({
		code: "READ_FAILED",
		stderr: "a".repeat(65_536),
	});
});

test("deadline includes a child that hangs after stdout closes", async () => {
	const fake = fakeJournal([], { held: true });
	const time = manualClock();
	const result = scanJournal({
		...scanInput,
		spawn: () => ({
			...fake.child,
			get signalCode() {
				return fake.child.signalCode;
			},
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			stderr: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
		}),
		clock: time.clock,
	});
	time.advance(1999);
	await Promise.resolve();
	await Promise.resolve();
	expect(fake.signals).toEqual([]);
	time.advance(1);
	expect(await result).toMatchObject({ status: "budget" });
	expect(fake.signals).toEqual(["SIGTERM"]);
	expect(time.timers.size).toBe(0);
});

test("a child ignoring TERM is killed at the 100 ms grace and always reaped", async () => {
	const fake = fakeJournal([], { held: true, ignoreTerm: true });
	const time = manualClock();
	const result = scanJournal({
		...scanInput,
		spawn: () => fake.child,
		clock: time.clock,
	});
	time.advance(2000);
	// The termination event is the synchronization point, not elapsed wall time.
	await Promise.resolve();
	await Promise.resolve();
	expect(fake.signals).toEqual(["SIGTERM"]);
	time.advance(99);
	expect(fake.signals).toEqual(["SIGTERM"]);
	time.advance(1);
	expect(await result).toMatchObject({ status: "budget", exitCode: 137 });
	expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(time.timers.size).toBe(0);
});

test("abort before spawn has no child, abort during scan retires it", async () => {
	const controller = new AbortController();
	controller.abort();
	let spawns = 0;
	const fake = fakeJournal([], { held: true });
	expect(
		await scanJournal({
			...scanInput,
			signal: controller.signal,
			spawn() {
				spawns++;
				return fake.child;
			},
		}),
	).toMatchObject({ status: "stopped", exitCode: null, skippedRecords: 0 });
	expect(spawns).toBe(0);
	const live = new AbortController();
	const result = scanJournal({
		...scanInput,
		signal: live.signal,
		spawn: () => fake.child,
	});
	live.abort();
	expect(await result).toMatchObject({ status: "stopped", exitCode: 143 });
	expect(fake.signals).toEqual(["SIGTERM"]);
});

test("consumer stop wins over induced zero exit and deadlines leave no timer", async () => {
	const fake = fakeJournal([journalLine()], { held: true });
	const time = manualClock();
	const result = await scanJournal({
		...scanInput,
		clock: time.clock,
		spawn: () => fake.child,
		onRecord() {
			fake.finish(0);
			return "stop";
		},
	});
	expect(result.status).toBe("stopped");
	expect(time.timers.size).toBe(0);
});
