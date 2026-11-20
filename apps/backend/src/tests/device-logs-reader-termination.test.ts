import { expect, test } from "bun:test";
import { scanJournal } from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";

test("abort requests retirement before waiting for the child", async () => {
	const abort = new AbortController();
	const fake = fakeJournal([], { held: true });
	const pending = scanJournal({
		...scanInput,
		spawn: () => fake.child,
		signal: abort.signal,
	});
	abort.abort();
	try {
		await Promise.resolve();
		await Promise.resolve();
		expect(fake.signals).toEqual(["SIGTERM"]);
	} finally {
		fake.finish(0);
		await Promise.allSettled([pending]);
	}
});

test("retirement preserves escalation until the child is reaped", async () => {
	const abort = new AbortController();
	const time = manualClock();
	const fake = fakeJournal([], { held: true, ignoreTerm: true });
	const pending = scanJournal({
		...scanInput,
		spawn: () => fake.child,
		signal: abort.signal,
		clock: time.clock,
	});
	abort.abort();
	try {
		await Promise.resolve();
		await Promise.resolve();
		time.advance(100);
		expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
	} finally {
		fake.finish(0);
		await Promise.allSettled([pending]);
	}
});

test("real process: nonzero 143 exit after stop", async () => {
	let native: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	const sent: string[] = [];
	const result = await scanJournal({
		...scanInput,
		spawn() {
			native = Bun.spawn(
				[
					"python3",
					"-u",
					"-c",
					`import sys,signal\nsignal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGTERM})\nsys.stdout.write(${JSON.stringify(journalLine())});sys.stdout.flush()\nsys.stdin.readline()\nsys.exit(143)`,
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
				kill(signal) {
					sent.push(signal);
					child.kill(signal);
					child.stdin.write("exit\n");
				},
			};
		},
		onRecord: () => "stop",
	}).catch((error: unknown) => error);
	expect(native ? await native.exited : null).toBe(143);
	expect(native?.signalCode).toBeNull();
	expect(sent).toEqual(["SIGTERM"]);
	expect(result).toMatchObject({ code: "READ_FAILED" });
});

test("missing termination kind cannot establish a clean exit", async () => {
	const fake = fakeJournal([journalLine()]);
	Object.defineProperty(fake.child, "signalCode", { value: undefined });
	await expect(
		scanJournal({ ...scanInput, spawn: () => fake.child }),
	).rejects.toMatchObject({ code: "READ_FAILED" });
});

test("spawn failure requires a literal ENOENT code", async () => {
	const error = Object.assign(new Error("spawn failed"), {
		code: { toString: () => "ENOENT" },
	});
	await expect(
		scanJournal({
			...scanInput,
			spawn() {
				throw error;
			},
		}),
	).rejects.toMatchObject({ code: "READ_FAILED" });
});

const intents = [
	{ label: "eof", action: "continue", sent: "none", status: "eof" },
	{ label: "stop/none", action: "stop", sent: "none", status: "stopped" },
	{ label: "stop/T", action: "stop", sent: "T", status: "stopped" },
	{ label: "stop/TK", action: "stop", sent: "TK", status: "stopped" },
	{ label: "abort/none", action: "abort", sent: "none", status: "stopped" },
	{ label: "abort/T", action: "abort", sent: "T", status: "stopped" },
	{ label: "abort/TK", action: "abort", sent: "TK", status: "stopped" },
	{ label: "budget/none", action: "budget", sent: "none", status: "budget" },
	{ label: "budget/T", action: "budget", sent: "T", status: "budget" },
	{ label: "budget/TK", action: "budget", sent: "TK", status: "budget" },
] as const;
const observations: ReadonlyArray<{
	name: string;
	code: number;
	signal: number | NodeJS.Signals | null;
	allowed: readonly string[];
}> = [
	{
		name: "normal 0",
		code: 0,
		signal: null,
		allowed: intents.map((i) => i.label),
	},
	{ name: "normal 1", code: 1, signal: null, allowed: [] },
	{ name: "normal 42", code: 42, signal: null, allowed: [] },
	{ name: "normal 137", code: 137, signal: null, allowed: [] },
	{ name: "normal 143", code: 143, signal: null, allowed: [] },
	{ name: "normal 255", code: 255, signal: null, allowed: [] },
	{
		name: "signal TERM",
		code: 143,
		signal: "SIGTERM",
		allowed: [
			"stop/T",
			"stop/TK",
			"abort/T",
			"abort/TK",
			"budget/T",
			"budget/TK",
		],
	},
	{
		name: "signal KILL",
		code: 137,
		signal: "SIGKILL",
		allowed: ["stop/TK", "abort/TK", "budget/TK"],
	},
	{ name: "signal INT", code: 130, signal: "SIGINT", allowed: [] },
	{ name: "signal HUP", code: 129, signal: "SIGHUP", allowed: [] },
	{ name: "signal QUIT", code: 131, signal: "SIGQUIT", allowed: [] },
	{ name: "signal PIPE", code: 141, signal: "SIGPIPE", allowed: [] },
	{ name: "unknown numeric signal 15", code: 143, signal: 15, allowed: [] },
	{ name: "unknown numeric signal 9", code: 137, signal: 9, allowed: [] },
];
for (const row of observations)
	for (const intent of intents)
		test(`termination table: ${row.name}, ${intent.label}`, async () => {
			const time = manualClock();
			const abort = new AbortController();
			const fake = fakeJournal([journalLine()], { held: true });
			const sent: string[] = [];
			const result = await scanJournal({
				...scanInput,
				signal: abort.signal,
				clock: time.clock,
				spawn() {
					if (intent.sent === "none") fake.finish(row.code, row.signal);
					return {
						...fake.child,
						get signalCode() {
							return fake.child.signalCode;
						},
						kill(signal) {
							sent.push(signal);
							if (signal === "SIGTERM" && intent.sent === "TK") {
								queueMicrotask(() => time.advance(100));
							} else fake.finish(row.code, row.signal);
						},
					};
				},
				onRecord() {
					if (intent.action === "abort") abort.abort();
					if (intent.action === "budget") time.advance(2000);
					return intent.action === "stop" ? "stop" : "continue";
				},
			}).catch((error: unknown) => error);
			if (row.allowed.includes(intent.label))
				expect(result).toMatchObject({
					status: intent.status,
					exitCode: row.code,
				});
			else expect(result).toMatchObject({ code: "READ_FAILED" });
			expect(sent).toEqual(
				intent.sent === "none"
					? []
					: intent.sent === "T"
						? ["SIGTERM"]
						: ["SIGTERM", "SIGKILL"],
			);
			expect(await fake.child.exited).toBe(row.code);
			expect(time.timers.size).toBe(0);
		});
