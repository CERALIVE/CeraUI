import { expect, test } from "bun:test";
import { scanJournal } from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";

test.each(["callback", "budget", "abort"] as const)(
	"%s stop never requests another stdout chunk",
	async (reason) => {
		const fake = fakeJournal([], { held: true });
		const abort = new AbortController();
		let pulls = 0;
		const stdout = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							journalLine().repeat(reason === "abort" ? 2 : 1),
						),
					);
				},
				pull() {
					pulls++;
				},
			},
			{ highWaterMark: 0 },
		);
		expect(
			await scanJournal({
				...scanInput,
				signal: abort.signal,
				limits: { records: reason === "budget" ? 0 : 4096 },
				spawn: () => ({
					...fake.child,
					stdout,
					get signalCode() {
						return fake.child.signalCode;
					},
				}),
				onRecord() {
					if (reason === "abort") {
						abort.abort();
						return "continue";
					}
					return "stop";
				},
			}),
		).toMatchObject({
			status: reason === "budget" ? "budget" : "stopped",
			exitCode: 143,
		});
		expect(pulls).toBe(0);
		expect(stdout.locked).toBe(false);
	},
);

test("invalid UTF-8 inside otherwise valid JSON cannot become a replacement-character success", async () => {
	const line = journalLine({ MESSAGE: "x" });
	const bytes = new TextEncoder().encode(line);
	bytes[line.indexOf('"x"') + 1] = 255;
	const fake = fakeJournal([bytes]);
	await expect(
		scanJournal({ ...scanInput, spawn: () => fake.child }),
	).rejects.toMatchObject({ code: "READ_FAILED" });
});

test("synchronous record work cannot postpone deadline enforcement until the next timer turn", async () => {
	const fake = fakeJournal([journalLine().repeat(3)], { held: true });
	const time = manualClock();
	let now = 10_000;
	let seen = 0;
	expect(
		(
			await scanJournal({
				...scanInput,
				clock: { ...time.clock, now: () => now },
				spawn: () => fake.child,
				onRecord() {
					seen++;
					now = 12_000;
					return "continue";
				},
			})
		).status,
	).toBe("budget");
	expect(seen).toBe(1);
});

test("one millisecond below the deadline still permits the next record", async () => {
	const fake = fakeJournal([journalLine().repeat(2)], { held: true });
	const time = manualClock();
	let now = 10_000;
	let seen = 0;
	const result = await scanJournal({
		...scanInput,
		clock: { ...time.clock, now: () => now },
		spawn: () => fake.child,
		onRecord() {
			seen++;
			now = 11_999;
			return seen === 2 ? "stop" : "continue";
		},
	});
	expect(result).toMatchObject({ status: "stopped", exitCode: 143 });
	expect(seen).toBe(2);
});

test("a valid large multiline chunk is bounded per line rather than traversal offset", async () => {
	const fake = fakeJournal([
		journalLine({ MESSAGE: "x".repeat(400_000) }).repeat(2),
	]);
	let seen = 0;
	expect(
		(
			await scanJournal({
				...scanInput,
				spawn: () => fake.child,
				onRecord() {
					seen++;
					return "continue";
				},
			})
		).status,
	).toBe("eof");
	expect(seen).toBe(2);
});

test.each(["{", "\0"])(
	"a single unfinished byte %j is not silently discarded at EOF",
	async (text) => {
		const fake = fakeJournal([text]);
		await expect(
			scanJournal({ ...scanInput, spawn: () => fake.child }),
		).rejects.toMatchObject({ code: "READ_FAILED" });
	},
);

test("stderr capture does not grow after a later chunk reaches the exact cap", async () => {
	const fake = fakeJournal([], { code: 1 });
	const stderr = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("a".repeat(65_536)));
			controller.enqueue(new TextEncoder().encode("b"));
			controller.close();
		},
	});
	await expect(
		scanJournal({
			...scanInput,
			spawn: () => ({ ...fake.child, stderr }),
		}),
	).rejects.toMatchObject({ code: "READ_FAILED", stderr: "a".repeat(65_536) });
});

test("a chunk released by termination after another pipe failed is never delivered", async () => {
	const fake = fakeJournal([], { held: true });
	let output: ReadableStreamDefaultController<Uint8Array>;
	let seen = 0;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			output = controller;
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(new Error("pipe failed"));
		},
	});
	await expect(
		scanJournal({
			...scanInput,
			spawn: () => ({
				...fake.child,
				get signalCode() {
					return fake.child.signalCode;
				},
				stdout,
				stderr,
				kill(signal) {
					output.enqueue(new TextEncoder().encode(journalLine()));
					output.close();
					fake.child.kill(signal);
				},
			}),
			onRecord() {
				seen++;
				return "continue";
			},
		}),
	).rejects.toMatchObject({ code: "READ_FAILED" });
	expect(seen).toBe(0);
});

test.each([true, false])(
	"oversize after 4096 candidates is RECORD_TOO_LARGE, not budget; newline=%s",
	async (newline) => {
		const prefix = Array.from({ length: 4096 }, (_, i) =>
			journalLine({ __CURSOR: `s=${i}` }),
		).join("");
		const large = journalLine({ MESSAGE: "x".repeat(1024 * 1024) });
		const fake = fakeJournal([prefix + (newline ? large : large.trimEnd())]);
		const time = manualClock();
		let seen = 0;
		await expect(
			scanJournal({
				...scanInput,
				clock: time.clock,
				spawn: () => fake.child,
				onRecord() {
					seen++;
					return "continue";
				},
			}),
		).rejects.toMatchObject({ code: "RECORD_TOO_LARGE" });
		expect(seen).toBe(4096);
		expect(time.timers.size).toBe(0);
	},
);
