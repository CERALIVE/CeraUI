import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { scanJournal } from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";

const pid = 123456789;
const path = `/proc/${pid}/stat`;
const stat = (state = "S", start = "100", processId = pid) =>
	`${processId} (name ) with spaces\nand parens) ${state} ${Array(18).fill("0").join(" ")} ${start}\n`;
const rows = [
	{ name: "live matching identity", text: stat(), dead: false },
	{ name: "zombie", text: stat("Z"), dead: true },
	{ name: "dead state", text: stat("X"), dead: true },
	{ name: "reused PID", text: stat("S", "101"), dead: true },
	{
		name: "missing at spawn never permits a reused PID",
		initialError: "ENOENT",
		text: stat("S", "200"),
		dead: true,
	},
	{
		name: "unreadable initial identity remains unknown",
		initialError: "EACCES",
		text: stat(),
		dead: false,
	},
	{ name: "missing stat", error: "ENOENT", dead: true },
	{ name: "gone process", error: "ESRCH", dead: true },
	{ name: "unreadable stat", error: "EACCES", dead: false },
	{ name: "unknown filesystem failure", error: "EIO", dead: false },
	{
		name: "coercible ENOENT code remains unknown",
		error: { toString: () => "ENOENT" },
		dead: false,
	},
	{
		name: "coercible ESRCH code remains unknown",
		error: { toString: () => "ESRCH" },
		dead: false,
	},
	{ name: "missing delimiter", text: `${pid} (name S 0`, dead: false },
	{
		name: "wrong PID header",
		text: stat().replace(String(pid), "7"),
		dead: false,
	},
	{
		name: "wrong PID cannot manufacture an identity change",
		text: stat("S", "200").replace(String(pid), "7"),
		dead: false,
	},
	{
		name: "missing delimiter cannot manufacture an identity change",
		pid: 1,
		text: `1 ( ${Array(18).fill("0").join(" ")} 200`,
		dead: false,
	},
	{ name: "missing starttime", text: `${pid} (name) S 0`, dead: false },
	{ name: "malformed starttime", text: stat("S", "bad"), dead: false },
	{ name: "malformed state", text: stat("SS"), dead: false },
] as const;

for (const row of rows)
	test(`pre-kill proc observation: ${row.name}`, async () => {
		const processId = "pid" in row ? row.pid : pid;
		const procPath = `/proc/${processId}/stat`;
		const fake = fakeJournal([journalLine()], { held: true });
		let reportedSignal: number | NodeJS.Signals | null = null;
		const exited = fake.child.exited.then((code) => {
			reportedSignal = fake.child.signalCode;
			return code;
		});
		const original = fs.readFileSync;
		let reads = 0;
		const read = spyOn(fs, "readFileSync").mockImplementation(
			new Proxy(original, {
				apply(target, receiver: unknown, args: unknown[]) {
					if (args[0] !== procPath)
						return Reflect.apply(target, receiver, args);
					reads++;
					if (reads === 1) {
						if ("initialError" in row)
							throw Object.assign(new Error(row.name), {
								code: row.initialError,
							});
						return stat("S", "100", processId);
					}
					if (row.dead) fake.finish(143, "SIGTERM");
					else queueMicrotask(() => fake.finish(143, "SIGTERM"));
					if ("error" in row)
						throw Object.assign(new Error(row.name), { code: row.error });
					return row.text;
				},
			}),
		);
		try {
			const result = await scanJournal({
				...scanInput,
				spawn: () => ({
					...fake.child,
					pid: processId,
					exited,
					get signalCode() {
						return reportedSignal;
					},
				}),
				onRecord: () => "stop",
			}).catch((error: unknown) => error);
			if (row.dead) {
				expect(result).toMatchObject({ code: "READ_FAILED" });
				expect(fake.signals).toEqual([]);
			} else {
				expect(result).toMatchObject({ status: "stopped", exitCode: 143 });
				expect(fake.signals).toEqual(["SIGTERM"]);
			}
			expect(reads).toBe(2);
		} finally {
			read.mockRestore();
		}
	});

test("non-Linux children use only native fields", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	const read = spyOn(fs, "readFileSync");
	const fake = fakeJournal([journalLine()], { held: true });
	try {
		Object.defineProperty(process, "platform", { value: "darwin" });
		expect(
			await scanJournal({
				...scanInput,
				spawn: () => ({
					...fake.child,
					pid,
					get signalCode() {
						return fake.child.signalCode;
					},
				}),
				onRecord: () => "stop",
			}),
		).toMatchObject({ status: "stopped", exitCode: 143 });
		expect(read.mock.calls.filter((call) => call[0] === path)).toEqual([]);
	} finally {
		if (descriptor) Object.defineProperty(process, "platform", descriptor);
		read.mockRestore();
	}
});

test("ESRCH while sending TERM is harmless and claims no ownership", async () => {
	const fake = fakeJournal([journalLine()], { held: true });
	let reportedSignal: number | NodeJS.Signals | null = null;
	const result = await scanJournal({
		...scanInput,
		spawn: () => ({
			...fake.child,
			exited: fake.child.exited.then((code) => {
				reportedSignal = fake.child.signalCode;
				return code;
			}),
			get signalCode() {
				return reportedSignal;
			},
			kill() {
				fake.finish(143, "SIGTERM");
				throw Object.assign(new Error("already gone"), { code: "ESRCH" });
			},
		}),
		onRecord: () => "stop",
	}).catch((error: unknown) => error);
	expect(result).toMatchObject({ code: "READ_FAILED" });
});

test.each([false, true])(
	"ESRCH on the first TERM cannot claim zero exit or escalate; PID=%s",
	async (withPid) => {
		const fake = fakeJournal([journalLine()], { held: true });
		const time = manualClock();
		const scheduled = spyOn(time.clock, "setTimeout");
		const original = fs.readFileSync;
		const read = spyOn(fs, "readFileSync").mockImplementation(
			new Proxy(original, {
				apply(target, receiver: unknown, args: unknown[]) {
					return args[0] === path
						? stat()
						: Reflect.apply(target, receiver, args);
				},
			}),
		);
		const result = await scanJournal({
			...scanInput,
			clock: time.clock,
			spawn: () => ({
				...fake.child,
				...(withPid ? { pid } : {}),
				get signalCode() {
					return fake.child.signalCode;
				},
				kill() {
					fake.finish(0);
					throw Object.assign(new Error("already gone"), { code: "ESRCH" });
				},
			}),
			onRecord: () => "stop",
		}).catch((error: unknown) => error);
		read.mockRestore();
		expect(result).toMatchObject({ code: "READ_FAILED" });
		expect(scheduled.mock.calls.map((call) => call[1])).toEqual([2000]);
		scheduled.mockRestore();
	},
);

test.each(["SIGTERM", "SIGKILL"] as const)(
	"ESRCH during escalation attributes only the earlier TERM; observed %s",
	async (observed) => {
		const fake = fakeJournal([journalLine()], { held: true, ignoreTerm: true });
		const time = manualClock();
		const attempts: string[] = [];
		const result = await scanJournal({
			...scanInput,
			clock: time.clock,
			spawn: () => ({
				...fake.child,
				get signalCode() {
					return fake.child.signalCode;
				},
				kill(signal) {
					attempts.push(signal);
					if (signal === "SIGTERM") {
						fake.child.kill(signal);
						queueMicrotask(() => time.advance(100));
						return;
					}
					fake.finish(observed === "SIGTERM" ? 143 : 137, observed);
					throw Object.assign(new Error("already gone"), { code: "ESRCH" });
				},
			}),
			onRecord: () => "stop",
		}).catch((error: unknown) => error);
		expect(attempts).toEqual(["SIGTERM", "SIGKILL"]);
		if (observed === "SIGTERM")
			expect(result).toMatchObject({ status: "stopped", exitCode: 143 });
		else expect(result).toMatchObject({ code: "READ_FAILED" });
	},
);

test.each(["EIO", { toString: () => "ESRCH" }])(
	"a non-ESRCH signal failure is preserved: %j",
	async (code) => {
		const fake = fakeJournal([journalLine()], { held: true });
		const failure = Object.assign(new Error("signal failed"), { code });
		const result = await scanJournal({
			...scanInput,
			spawn: () => ({
				...fake.child,
				get signalCode() {
					return fake.child.signalCode;
				},
				kill() {
					fake.finish(143, "SIGTERM");
					throw failure;
				},
			}),
			onRecord: () => "stop",
		}).catch((error: unknown) => error);
		expect(result).toBe(failure);
	},
);

test.each(["exitCode", "signalCode", "killed"] as const)(
	"native-only %s observes death before its exit promise is reported",
	async (field) => {
		const fake = fakeJournal([journalLine()], { held: true });
		const exit = Promise.withResolvers<number>();
		let dead = false;
		const result = await scanJournal({
			...scanInput,
			spawn: () => ({
				...fake.child,
				exited: exit.promise,
				get exitCode() {
					return dead && field === "exitCode" ? 143 : null;
				},
				get signalCode() {
					return dead && field === "signalCode" ? "SIGTERM" : null;
				},
				get killed() {
					return dead && field === "killed";
				},
			}),
			onRecord() {
				dead = true;
				fake.finish(143, "SIGTERM");
				queueMicrotask(() => queueMicrotask(() => exit.resolve(143)));
				return "stop";
			},
		}).catch((error: unknown) => error);
		expect(result).toMatchObject({ code: "READ_FAILED" });
		expect(fake.signals).toEqual([]);
	},
);
