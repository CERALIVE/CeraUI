import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	classifyTermination,
	trackOwnership,
} from "../modules/device-logs/termination.ts";

const intents = [
	{ label: "eof", sent: "none", status: "eof" },
	{ label: "stop/none", sent: "none", status: "stopped" },
	{ label: "stop/T", sent: "T", status: "stopped" },
	{ label: "stop/TK", sent: "TK", status: "stopped" },
	{ label: "abort/none", sent: "none", status: "stopped" },
	{ label: "abort/T", sent: "T", status: "stopped" },
	{ label: "abort/TK", sent: "TK", status: "stopped" },
	{ label: "budget/none", sent: "none", status: "budget" },
	{ label: "budget/T", sent: "T", status: "budget" },
	{ label: "budget/TK", sent: "TK", status: "budget" },
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
		for (const diedBeforeOurSignal of [false, true])
			test(`termination: ${row.name}, ${intent.label}, prior death=${diedBeforeOurSignal}`, () => {
				expect(
					classifyTermination(row.code, row.signal, {
						status: intent.status,
						termSent: intent.sent !== "none",
						killSent: intent.sent === "TK",
						diedBeforeOurSignal,
					}),
				).toBe(
					!diedBeforeOurSignal && row.allowed.includes(intent.label)
						? intent.status
						: "READ_FAILED",
				);
			});

test("unknown exit cannot establish normal completion", () => {
	expect(
		classifyTermination(null, null, {
			status: "eof",
			termSent: false,
			killSent: false,
			diedBeforeOurSignal: false,
		}),
	).toBe("READ_FAILED");
});
test.each([0, undefined, "SIGUSR1"])(
	"unknown or external termination kind %s cannot become reader TERM",
	(signalCode) => {
		const result: unknown = Reflect.apply(classifyTermination, undefined, [
			0,
			signalCode,
			{
				status: "stopped",
				termSent: true,
				killSent: false,
				diedBeforeOurSignal: false,
			},
		]);
		expect(result).toBe("READ_FAILED");
	},
);
test.each(["SIGTERM", "SIGKILL"] as const)(
	"EOF never owns a %s death even with signals issued",
	(signal) => {
		expect(
			classifyTermination(0, signal, {
				status: "eof",
				termSent: true,
				killSent: true,
				diedBeforeOurSignal: false,
			}),
		).toBe("READ_FAILED");
	},
);

const pid = 123456789;
const stat = (state = "S", start = "100", processId = pid) =>
	`${processId} (name ) with spaces\nand parens) ${state} ${Array(18).fill("0").join(" ")} ${start}\n`;
type Proc = string | { readonly error: unknown };
const failure = (code: unknown) => ({
	error: Object.assign(new Error("proc failed"), { code }),
});
const absentCode = new Proxy(new Error("absent code"), {
	get(target, key, receiver: unknown) {
		return key === "code" ? "ESRCH" : Reflect.get(target, key, receiver);
	},
});
function withProc(initial: Proc, next: Proc, run: () => void) {
	const original = fs.readFileSync;
	let reads = 0;
	const read = spyOn(fs, "readFileSync").mockImplementation(
		new Proxy(original, {
			apply(target, receiver: unknown, args: unknown[]) {
				if (args[0] !== `/proc/${pid}/stat`)
					return Reflect.apply(target, receiver, args);
				expect(args[1]).toBe("utf8");
				const value = reads++ === 0 ? initial : next;
				if (typeof value !== "string") throw value.error;
				return value;
			},
		}),
	);
	try {
		run();
		expect(reads).toBe(2);
	} finally {
		read.mockRestore();
	}
}
function child(): {
	pid: number;
	exitCode: number | null;
	signalCode: number | NodeJS.Signals | null;
	killed: boolean;
	signals: string[];
	kill(signal: "SIGTERM" | "SIGKILL"): void;
} {
	const signals: string[] = [];
	return {
		pid,
		exitCode: null,
		signalCode: null,
		killed: false,
		signals,
		kill(signal: "SIGTERM" | "SIGKILL") {
			signals.push(signal);
		},
	};
}
const procRows: ReadonlyArray<{
	name: string;
	initial?: Proc;
	next: Proc;
	dead: boolean;
}> = [
	{ name: "live matching identity", next: stat(), dead: false },
	{ name: "zombie", next: stat("Z"), dead: true },
	{ name: "dead state", next: stat("X"), dead: true },
	{ name: "reused PID", next: stat("S", "101"), dead: true },
	{ name: "earlier reused identity", next: stat("S", "0"), dead: true },
	{ name: "tracing stop is alive", next: stat("t"), dead: false },
	{
		name: "leading state whitespace preserves identity",
		next: stat("S", "101").replace(") S", ")   S"),
		dead: true,
	},
	{
		name: "mixed repeated whitespace preserves identity",
		next: stat("S", "101").replaceAll(" 0", " \t 0"),
		dead: true,
	},
	{
		name: "missing at spawn",
		initial: failure("ENOENT"),
		next: stat("S", "200"),
		dead: true,
	},
	{
		name: "gone at spawn",
		initial: failure("ESRCH"),
		next: stat(),
		dead: true,
	},
	{
		name: "unknown initial identity",
		initial: failure("EACCES"),
		next: stat("S", "101"),
		dead: false,
	},
	{ name: "missing stat", next: failure("ENOENT"), dead: true },
	{ name: "gone process", next: failure("ESRCH"), dead: true },
	{ name: "unreadable stat", next: failure("EACCES"), dead: false },
	{ name: "filesystem failure", next: failure("EIO"), dead: false },
	{
		name: "absent error code remains unknown",
		next: { error: absentCode },
		dead: false,
	},
	{
		name: "non Error failure",
		next: { error: { code: "ENOENT" } },
		dead: false,
	},
	{
		name: "Error without code",
		next: { error: new Error("unknown") },
		dead: false,
	},
	{
		name: "coercible ENOENT",
		next: failure({ toString: () => "ENOENT" }),
		dead: false,
	},
	{
		name: "coercible ESRCH",
		next: failure({ toString: () => "ESRCH" }),
		dead: false,
	},
	{ name: "missing delimiter", next: `${pid} (name S 0`, dead: false },
	{ name: "wrong PID", next: stat("S", "200", 7), dead: false },
	{
		name: "PID prefix is not the child",
		next: stat("S", "200", pid * 10),
		dead: false,
	},
	{
		name: "wrong opening delimiter",
		next: stat("S", "200").replace(" (", " ["),
		dead: false,
	},
	{ name: "missing starttime", next: `${pid} (name) S 0`, dead: false },
	{ name: "malformed starttime", next: stat("S", "bad"), dead: false },
	{ name: "starttime with prefix", next: stat("S", "x101"), dead: false },
	{ name: "starttime with suffix", next: stat("S", "101x"), dead: false },
	{ name: "malformed state", next: stat("SS"), dead: false },
	{
		name: "SS/100 then S/101",
		initial: stat("SS"),
		next: stat("S", "101"),
		dead: false,
	},
	{ name: "S/100 then SS/101", next: stat("SS", "101"), dead: false },
	{
		name: "SS/100 then SS/101",
		initial: stat("SS"),
		next: stat("SS", "101"),
		dead: false,
	},
	{ name: "empty state", next: `${pid} (name) `, dead: false },
	{
		name: "zero starttime is valid",
		initial: stat("S", "0"),
		next: stat("S", "1"),
		dead: true,
	},
];
for (const row of procRows)
	test(`proc ownership: ${row.name}`, () => {
		withProc(row.initial ?? stat(), row.next, () => {
			const fake = child();
			const owner = trackOwnership(fake);
			expect(owner.diedBeforeOurSignal).toBe(false);
			expect(owner.send("SIGTERM")).toBe(!row.dead);
			expect(fake.signals).toEqual(row.dead ? [] : ["SIGTERM"]);
			expect(owner.diedBeforeOurSignal).toBe(row.dead);
		});
	});

for (const value of [
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"109",
	"0123456789",
	"999999999",
	"900719925474099312345678901234567890",
])
	for (const [initial, next] of [
		["100", value],
		[value, "100"],
		[value, value],
	] as const)
		test(`numeric starttime identity: ${initial} -> ${next}`, () => {
			withProc(stat("S", initial), stat("S", next), () => {
				const fake = child();
				const owner = trackOwnership(fake);
				const changed = initial !== next;
				expect(owner.diedBeforeOurSignal).toBe(false);
				expect(owner.send("SIGTERM")).toBe(!changed);
				expect(fake.signals).toEqual(changed ? [] : ["SIGTERM"]);
				expect(owner.diedBeforeOurSignal).toBe(changed);
			});
		});

for (const value of ["A", "+100", "1.0"])
	for (const [initial, next] of [
		["100", value],
		[value, "109"],
	] as const)
		test(`invalid starttime remains unknown: ${initial} -> ${next}`, () => {
			withProc(stat("S", initial), stat("S", next), () => {
				const fake = child();
				const owner = trackOwnership(fake);
				expect(owner.diedBeforeOurSignal).toBe(false);
				expect(owner.send("SIGTERM")).toBe(true);
				expect(fake.signals).toEqual(["SIGTERM"]);
				expect(owner.diedBeforeOurSignal).toBe(false);
			});
		});

for (const separator of ["\r", "\v", "\u00a0"]) {
	const spaced = (start: string) =>
		stat("S", start).replaceAll(" 0", `${separator}0`);
	for (const [stage, initial, next, changed] of [
		["spawn", spaced("100"), stat("S", "109"), true],
		["signal", stat("S", "100"), spaced("109"), true],
		["matching", spaced("109"), spaced("109"), false],
	] as const)
		test(`proc whitespace ${JSON.stringify(separator)} at ${stage}`, () => {
			withProc(initial, next, () => {
				const fake = child();
				const owner = trackOwnership(fake);
				expect(owner.diedBeforeOurSignal).toBe(false);
				expect(owner.send("SIGTERM")).toBe(!changed);
				expect(fake.signals).toEqual(changed ? [] : ["SIGTERM"]);
				expect(owner.diedBeforeOurSignal).toBe(changed);
			});
		});
}

test("a missing delimiter cannot manufacture an identity change for PID 1", () => {
	const read = spyOn(fs, "readFileSync").mockReturnValue(stat("S", "100", 1));
	const fake = { ...child(), pid: 1 };
	try {
		const owner = trackOwnership(fake);
		read.mockReturnValue(`1 ( ${Array(18).fill("0").join(" ")} 200`);
		expect(owner.send("SIGTERM")).toBe(true);
		expect(owner.diedBeforeOurSignal).toBe(false);
		expect(fake.signals).toEqual(["SIGTERM"]);
		const calls: readonly unknown[] = read.mock.calls;
		expect(calls).toEqual([
			["/proc/1/stat", "utf8"],
			["/proc/1/stat", "utf8"],
		]);
	} finally {
		read.mockRestore();
	}
});
test.each([null, undefined])(
	"absent native exit fields with signal %s remain alive",
	(signalCode) => {
		const signals: string[] = [];
		const owner: ReturnType<typeof trackOwnership> = Reflect.apply(
			trackOwnership,
			undefined,
			[{ signalCode, kill: (signal: string) => signals.push(signal) }],
		);
		expect(owner.send("SIGTERM")).toBe(true);
		expect(owner.diedBeforeOurSignal).toBe(false);
		expect(signals).toEqual(["SIGTERM"]);
	},
);

test.each(["exitCode", "signalCode", "killed"] as const)(
	"native %s death is observed after eager proc read",
	(field) => {
		withProc(stat(), stat(), () => {
			const fake = child();
			const owner = trackOwnership(fake);
			if (field === "exitCode") fake.exitCode = 0;
			if (field === "signalCode") fake.signalCode = 0;
			if (field === "killed") fake.killed = true;
			expect(owner.send("SIGTERM")).toBe(false);
			expect(owner.diedBeforeOurSignal).toBe(true);
			expect(fake.signals).toEqual([]);
		});
	},
);
test.each(["no pid", "darwin", "win32"] as const)(
	"%s reads no proc",
	(mode) => {
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const read = spyOn(fs, "readFileSync");
		const fake = child();
		const { pid: _pid, ...withoutPid } = fake;
		try {
			if (mode !== "no pid")
				Object.defineProperty(process, "platform", { value: mode });
			const owner = trackOwnership(mode === "no pid" ? withoutPid : fake);
			expect(owner.send("SIGTERM")).toBe(true);
			expect(owner.diedBeforeOurSignal).toBe(false);
			expect(fake.signals).toEqual(["SIGTERM"]);
			expect(read).not.toHaveBeenCalled();
		} finally {
			if (descriptor) Object.defineProperty(process, "platform", descriptor);
			read.mockRestore();
		}
	},
);
test.each(["dead", "ESRCH", "alive"] as const)(
	"escalation after valid TERM retains its ownership: %s",
	(mode) => {
		const fake = child();
		const { pid: _pid, ...native } = fake;
		const owner = trackOwnership(native);
		expect(owner.send("SIGTERM")).toBe(true);
		if (mode === "dead") native.exitCode = 143;
		if (mode === "ESRCH")
			native.kill = () => {
				throw failure("ESRCH").error;
			};
		expect(owner.send("SIGKILL")).toBe(mode === "alive");
		expect(owner.diedBeforeOurSignal).toBe(false);
		expect(fake.signals).toEqual(
			mode === "alive" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"],
		);
	},
);
test.each([true, false])(
	"first TERM ESRCH owns no signal; pid=%s",
	(withPid) => {
		const fake = child();
		const { pid: _pid, ...native } = fake;
		native.kill = () => {
			throw failure("ESRCH").error;
		};
		const run = () => {
			const owner = trackOwnership(withPid ? { ...native, pid } : native);
			expect(owner.send("SIGTERM")).toBe(false);
			expect(owner.diedBeforeOurSignal).toBe(true);
			expect(fake.signals).toEqual([]);
		};
		if (withPid) withProc(stat(), stat(), run);
		else run();
	},
);
test.each([
	failure("EIO").error,
	failure({ toString: () => "ESRCH" }).error,
	new Error("no code"),
	{ code: "ESRCH" },
	absentCode,
])("non-ESRCH kill errors propagate unchanged: %j", (error) => {
	const fake = child();
	const { pid: _pid, ...native } = fake;
	native.kill = () => {
		throw error;
	};
	const owner = trackOwnership(native);
	let caught: unknown;
	try {
		owner.send("SIGTERM");
	} catch (thrown) {
		caught = thrown;
	}
	expect(caught).toBe(error);
	expect(owner.diedBeforeOurSignal).toBe(false);
});
