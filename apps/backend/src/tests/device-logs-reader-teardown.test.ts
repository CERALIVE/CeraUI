import { expect, test } from "bun:test";
import {
	JournalReadError,
	scanJournal,
} from "../modules/device-logs/reader.ts";
import { JournalSignalError } from "../modules/device-logs/termination.ts";
import {
	fakeJournal,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";
import { turn } from "./helpers/history-clear.ts";

test.each(["SIGTERM", "SIGKILL"] as const)(
	"reader releases both pipes and waits for reaping when %s throws",
	async (fault) => {
		const time = manualClock();
		const controller = new AbortController();
		const fake = fakeJournal([], { held: true, ignoreTerm: true });
		const failure = new Error("signal refused");
		const signals: string[] = [];
		let settled = false;
		const scan = scanJournal({
			...scanInput,
			clock: time.clock,
			signal: controller.signal,
			spawn: () => ({
				...fake.child,
				kill(signal) {
					signals.push(signal);
					if (signal === fault) throw failure;
				},
			}),
		}).then(
			(value) => {
				settled = true;
				return value;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		try {
			controller.abort();
			await turn();
			expect(() => time.advance(100)).not.toThrow();
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
			expect(fake.child.stdout.locked).toBe(false);
			expect(fake.child.stderr.locked).toBe(false);
			expect(settled).toBe(false);
			fake.finish();
			const result = await scan;
			expect(result).toBeInstanceOf(JournalReadError);
			expect(result).toMatchObject({
				code: "READ_FAILED",
				cause: new JournalSignalError(fault, failure),
			});
			expect(time.timers.size).toBe(0);
		} finally {
			fake.finish();
			await scan;
		}
	},
);
