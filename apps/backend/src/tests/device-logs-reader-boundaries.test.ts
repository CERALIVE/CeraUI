import { expect, spyOn, test } from "bun:test";
import { scanJournal } from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";

test.each([0, 1])(
	"default eight MiB stdout boundary plus %d byte is exact",
	async (extra) => {
		const overhead = journalLine({ MESSAGE: "" }).length;
		const line = journalLine({ MESSAGE: "x".repeat(1024 * 1024 - overhead) });
		const chunks = Array<string>(8).fill(line);
		if (extra) chunks.push(" ");
		const fake = fakeJournal(chunks);
		expect(
			(await scanJournal({ ...scanInput, spawn: () => fake.child })).status,
		).toBe(extra ? "budget" : "eof");
	},
);

test("deadline includes slow spawn at a nonzero monotonic clock origin", async () => {
	const fake = fakeJournal([], { held: true });
	const time = manualClock();
	time.advance(10_000);
	const result = scanJournal({
		...scanInput,
		clock: time.clock,
		spawn() {
			time.advance(500);
			return fake.child;
		},
	});
	time.advance(1499);
	await Promise.resolve();
	await Promise.resolve();
	expect(fake.signals).toEqual([]);
	time.advance(1);
	expect(await result).toMatchObject({ status: "budget" });
});

test("a spawn that already exhausted the budget is retired immediately", async () => {
	const fake = fakeJournal([], { held: true });
	const time = manualClock();
	const result = scanJournal({
		...scanInput,
		clock: time.clock,
		spawn() {
			time.advance(3000);
			return fake.child;
		},
	});
	time.advance(0);
	expect(await result).toMatchObject({ status: "budget" });
});

test("an exhausted deadline never submits a negative delay to the clock", async () => {
	const fake = fakeJournal([], { held: true });
	const time = manualClock();
	const result = scanJournal({
		...scanInput,
		clock: {
			...time.clock,
			setTimeout(callback, delay) {
				expect(delay).toBeGreaterThanOrEqual(0);
				return time.clock.setTimeout(callback, delay);
			},
		},
		spawn() {
			time.advance(3000);
			return fake.child;
		},
	});
	time.advance(0);
	expect((await result).status).toBe("budget");
});

test("cleanup submits only allocated numeric timer handles to the clock", async () => {
	const fake = fakeJournal([journalLine()]);
	const time = manualClock();
	expect(
		(
			await scanJournal({
				...scanInput,
				clock: {
					...time.clock,
					clearTimeout(timer) {
						expect(typeof timer).toBe("number");
						time.clock.clearTimeout(timer);
					},
				},
				spawn: () => fake.child,
			})
		).status,
	).toBe("eof");
});

test.each([null, undefined, "ENOENT", { code: "ENOENT" }])(
	"unexpected thrown spawn value %j is a typed read failure",
	async (error) => {
		await expect(
			scanJournal({
				...scanInput,
				spawn() {
					throw error;
				},
			}),
		).rejects.toMatchObject({
			code: "READ_FAILED",
			name: "JournalReadError",
			stderr: "",
		});
	},
);

test("unexpected JSON decoder infrastructure failure is propagated after reaping", async () => {
	const fake = fakeJournal([journalLine()], { held: true });
	const error = new RangeError("decoder unavailable");
	const decode = spyOn(JSON, "parse").mockImplementationOnce(() => {
		throw error;
	});
	try {
		await expect(
			scanJournal({ ...scanInput, spawn: () => fake.child }),
		).rejects.toBe(error);
		expect(fake.signals).toEqual(["SIGTERM"]);
	} finally {
		decode.mockRestore();
	}
});
