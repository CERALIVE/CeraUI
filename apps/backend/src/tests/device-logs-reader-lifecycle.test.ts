import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanJournal } from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";

test("default spawn ignores stdin and pipes both outputs without a shell", async () => {
	const dir = mkdtempSync(join(tmpdir(), "journal-reader-shim-"));
	const oldPath = process.env.PATH;
	writeFileSync(
		join(dir, "journalctl"),
		`#!/bin/sh\nprintf '%s' '${journalLine()}'\n`,
		{ mode: 0o700 },
	);
	process.env.PATH = `${dir}:${oldPath}`;
	const spawn = spyOn(Bun, "spawn");
	try {
		expect((await scanJournal(scanInput)).status).toBe("eof");
		expect(spawn.mock.calls[0]?.[1]).toMatchObject({
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
	} finally {
		spawn.mockRestore();
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
});

test.each(["stdout", "stderr"] as const)(
	"%s read rejection is typed and the child is reaped",
	async (stream) => {
		const fake = fakeJournal([], { held: true });
		const child = {
			...fake.child,
			get signalCode() {
				return fake.child.signalCode;
			},
			[stream]: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("broken pipe"));
				},
			}),
		};
		await expect(
			scanJournal({ ...scanInput, spawn: () => child }),
		).rejects.toMatchObject({ code: "READ_FAILED" });
		expect(fake.signals).toEqual(["SIGTERM"]);
	},
);

test("abort from inside a callback prevents the next buffered delivery", async () => {
	const controller = new AbortController();
	const fake = fakeJournal([journalLine().repeat(3)], { held: true });
	let seen = 0;
	const result = await scanJournal({
		...scanInput,
		signal: controller.signal,
		spawn: () => fake.child,
		onRecord() {
			seen++;
			controller.abort();
			return "continue";
		},
	});
	expect(result.status).toBe("stopped");
	expect(seen).toBe(1);
});

test("abort raised during spawn is still observed after listener installation", async () => {
	const controller = new AbortController();
	const fake = fakeJournal([], { held: true });
	expect(
		(
			await scanJournal({
				...scanInput,
				signal: controller.signal,
				spawn() {
					controller.abort();
					return fake.child;
				},
			})
		).status,
	).toBe("stopped");
	expect(fake.signals).toEqual(["SIGTERM"]);
});

test("elapsed deadline during synchronous delivery stops the next record", async () => {
	const time = manualClock();
	const fake = fakeJournal([journalLine().repeat(3)], { held: true });
	let seen = 0;
	expect(
		(
			await scanJournal({
				...scanInput,
				clock: time.clock,
				spawn: () => fake.child,
				onRecord() {
					seen++;
					time.advance(2000);
					return "continue";
				},
			})
		).status,
	).toBe("budget");
	expect(seen).toBe(1);
});

test("zero exit with inherited open pipes is bounded by the deadline", async () => {
	const time = manualClock();
	const fake = fakeJournal([], { held: true });
	const result = scanJournal({
		...scanInput,
		clock: time.clock,
		spawn: () => ({
			...fake.child,
			exited: Promise.resolve(0),
			get signalCode() {
				return fake.child.signalCode;
			},
		}),
	});
	time.advance(2000);
	expect(await result).toMatchObject({ status: "budget", exitCode: 0 });
	expect(fake.signals).toEqual([]);
});

test("a zero exit caused by TERM is a budget stop, never EOF", async () => {
	const time = manualClock();
	const fake = fakeJournal([], { held: true });
	const result = scanJournal({
		...scanInput,
		clock: time.clock,
		spawn: () => ({
			...fake.child,
			get signalCode() {
				return fake.child.signalCode;
			},
			kill() {
				fake.finish(0);
			},
		}),
	});
	time.advance(2000);
	expect(await result).toMatchObject({ status: "budget", exitCode: 0 });
});

test("a nonzero exit predating a requested stop cannot masquerade as success", async () => {
	const fake = fakeJournal([journalLine()], { code: 1 });
	await expect(
		scanJournal({
			...scanInput,
			spawn: () => fake.child,
			onRecord: () => "stop",
		}),
	).rejects.toMatchObject({ code: "READ_FAILED" });
});

test("an around scan can accept a reaped clean exit without claiming a signal or EOF", async () => {
	const fake = fakeJournal([journalLine()], { held: true });
	const result = await scanJournal({
		...scanInput,
		acceptConcurrentCleanExit: true,
		spawn: () => ({
			...fake.child,
			get exitCode() {
				fake.finish();
				return 0;
			},
		}),
		onRecord: () => "stop",
	});
	expect(result).toEqual({ status: "stopped", exitCode: 0, skippedRecords: 0 });
	expect(fake.signals).toEqual([]);
});

test("successful EOF clears timers and removes abort ownership", async () => {
	const time = manualClock();
	const controller = new AbortController();
	const add = spyOn(controller.signal, "addEventListener");
	const remove = spyOn(controller.signal, "removeEventListener");
	const fake = fakeJournal([journalLine()]);
	try {
		expect(
			(
				await scanJournal({
					...scanInput,
					clock: time.clock,
					signal: controller.signal,
					spawn: () => fake.child,
				})
			).status,
		).toBe("eof");
		expect(time.timers.size).toBe(0);
		expect(remove.mock.calls[0]?.[0]).toBe("abort");
		expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
		controller.abort();
		expect(fake.signals).toEqual([]);
	} finally {
		add.mockRestore();
		remove.mockRestore();
	}
});

test.each([0, 1])(
	"stdout byte limit boundary offset %d is exact",
	async (offset) => {
		const text = journalLine();
		const fake = fakeJournal([text]);
		const result = await scanJournal({
			...scanInput,
			limits: { stdoutBytes: new TextEncoder().encode(text).length - offset },
			spawn: () => fake.child,
		});
		expect(result.status).toBe(offset === 0 ? "eof" : "budget");
	},
);
