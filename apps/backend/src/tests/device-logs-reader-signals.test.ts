import { expect, test } from "bun:test";
import {
	type JournalChild,
	scanJournal,
} from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";

test.each(["continue", "stop", "abort"] as const)(
	"unowned SIGKILL stays READ_FAILED with %s",
	async (action) => {
		let native: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
		const sentByReader: string[] = [];
		const signal = new AbortController();
		const result = await scanJournal({
			...scanInput,
			signal: signal.signal,
			spawn() {
				native = Bun.spawn(
					["bash", "-c", `printf '%s' '${journalLine()}'; read -r line`],
					{ env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
				);
				const child = native;
				return {
					stdout: child.stdout,
					stderr: child.stderr,
					exited: child.exited,
					get signalCode() {
						return child.signalCode;
					},
					kill(s) {
						sentByReader.push(s);
						child.kill(s);
					},
				} satisfies JournalChild;
			},
			onRecord() {
				native?.kill("SIGKILL");
				if (action === "abort") signal.abort();
				return action === "stop" ? "stop" : "continue";
			},
		}).catch((error: unknown) => error);
		expect(native ? await native.exited : null).toBe(137);
		expect(sentByReader).not.toContain("SIGKILL");
		expect(result).toMatchObject({ code: "READ_FAILED" });
	},
);

const exits = [
	{ code: 0, before: "stopped", retire: "stopped" },
	{ code: 1, before: "READ_FAILED", retire: "READ_FAILED" },
	{ code: 129, before: "READ_FAILED", retire: "READ_FAILED" },
	{ code: 130, before: "READ_FAILED", retire: "READ_FAILED" },
	{ code: 137, before: "READ_FAILED", retire: "READ_FAILED" },
	{ code: 139, before: "READ_FAILED", retire: "READ_FAILED" },
	{ code: 143, before: "READ_FAILED", retire: "READ_FAILED" },
	{ code: 255, before: "READ_FAILED", retire: "READ_FAILED" },
] as const;
for (const timing of ["before", "retire"] as const)
	for (const row of exits)
		test.each(["stop", "abort", "budget"] as const)(
			`exit ${row.code} ${timing} %s preserves exit ownership`,
			async (action) => {
				const signal = new AbortController();
				const time = manualClock();
				const fake = fakeJournal([journalLine()], {
					held: true,
					stderr: "child diagnostic",
				});
				const sent: string[] = [];
				const result = await scanJournal({
					...scanInput,
					signal: signal.signal,
					clock: time.clock,
					spawn: () => ({
						...fake.child,
						kill(s) {
							sent.push(s);
							fake.finish(row.code);
						},
					}),
					onRecord() {
						if (timing === "before") fake.finish(row.code);
						if (action === "abort") signal.abort();
						if (action === "budget") time.advance(2000);
						return action === "stop" ? "stop" : "continue";
					},
				}).catch((error: unknown) => error);
				if (row[timing] === "READ_FAILED")
					expect(result).toMatchObject({
						code: "READ_FAILED",
						stderr: "child diagnostic",
					});
				else
					expect(result).toMatchObject({
						status: action === "budget" ? "budget" : "stopped",
						exitCode: row.code,
					});
				expect(await fake.child.exited).toBe(row.code);
				expect(sent).not.toContain("SIGKILL");
				expect(time.timers.size).toBe(0);
			},
		);

test("external SIGKILL after the reader's SIGTERM remains READ_FAILED", async () => {
	const sent: string[] = [];
	let native: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	const result = await scanJournal({
		...scanInput,
		spawn() {
			native = Bun.spawn(
				[
					"bash",
					"-c",
					`trap '' TERM; printf '%s' '${journalLine()}'; read -r line`,
				],
				{ env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			const child = native;
			return {
				stdout: child.stdout,
				stderr: child.stderr,
				exited: child.exited,
				get signalCode() {
					return child.signalCode;
				},
				kill(s) {
					sent.push(s);
					child.kill(s);
					child.kill("SIGKILL");
				},
			};
		},
		onRecord: () => "stop",
	}).catch((error: unknown) => error);
	expect(sent).toEqual(["SIGTERM"]);
	expect(native ? await native.exited : null).toBe(137);
	expect(result).toMatchObject({ code: "READ_FAILED" });
});

test("external SIGKILL after abort remains READ_FAILED", async () => {
	const signal = new AbortController();
	const fake = fakeJournal([journalLine()], { held: true });
	const result = await scanJournal({
		...scanInput,
		spawn: () => fake.child,
		signal: signal.signal,
		onRecord() {
			signal.abort();
			fake.finish(137);
			return "continue";
		},
	}).catch((error: unknown) => error);
	expect(fake.signals).not.toContain("SIGKILL");
	expect(result).toMatchObject({ code: "READ_FAILED" });
});
