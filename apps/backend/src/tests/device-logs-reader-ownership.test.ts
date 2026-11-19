import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { scanJournal } from "../modules/device-logs/reader.ts";
import {
	journalLine,
	manualClock,
	scanInput,
} from "./helpers/device-journal.ts";

const externalDeath = [
	{ name: "TERM", signal: "SIGTERM", code: null },
	{ name: "KILL", signal: "SIGKILL", code: null },
	{ name: "INT", signal: "SIGINT", code: null },
	{ name: "HUP", signal: "SIGHUP", code: null },
	{ name: "QUIT", signal: "SIGQUIT", code: null },
	{ name: "normal 42", signal: "SIGUSR1", code: 42 },
	{ name: "normal 0", signal: "SIGUSR1", code: 0 },
] as const;
for (const end of externalDeath)
	test.each(["stop", "abort", "budget"] as const)(
		`pidfd external ${end.name} death before %s is not reader-owned`,
		async (action) => {
			const time = manualClock();
			const scheduled = spyOn(time.clock, "setTimeout");
			const abort = new AbortController();
			const sent: string[] = [];
			let native: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
			let observed = "";
			const result = await scanJournal({
				...scanInput,
				signal: abort.signal,
				clock: time.clock,
				spawn() {
					const script = [
						"import sys,signal,resource",
						"resource.setrlimit(resource.RLIMIT_CORE,(0,0))",
						"signal.signal(signal.SIGINT,signal.SIG_DFL)",
						end.code === null
							? ""
							: `signal.signal(signal.SIGUSR1,lambda *_:sys.exit(${end.code}))`,
						`sys.stdout.write(${JSON.stringify(journalLine())});sys.stdout.flush()`,
						"sys.stdin.readline()",
					]
						.filter(Boolean)
						.join("\n");
					native = Bun.spawn(["python3", "-u", "-c", script], {
						env: process.env,
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					});
					const child = native;
					return {
						pid: child.pid,
						stdout: child.stdout,
						stderr: child.stderr,
						exited: child.exited,
						get signalCode() {
							return child.signalCode;
						},
						get exitCode() {
							return child.exitCode;
						},
						get killed() {
							return child.killed;
						},
						kill(signal) {
							sent.push(signal);
							child.kill(signal);
						},
					};
				},
				onRecord() {
					if (!native) throw new Error("Child was not spawned");
					// Block only this test's Bun callback while another process observes kernel death.
					observed = execFileSync(
						"python3",
						[
							"-c",
							[
								"import os,signal,select,sys",
								"pid=int(sys.argv[1]);fd=os.pidfd_open(pid)",
								`signal.pidfd_send_signal(fd,signal.${end.signal})`,
								"poll=select.poll();poll.register(fd,select.POLLIN);poll.poll()",
								"print('EXTERNAL_DEATH_OBSERVED')",
							].join("\n"),
							String(native.pid),
						],
						{ encoding: "utf8", timeout: 3000 },
					);
					if (action === "abort") abort.abort();
					if (action === "budget") time.advance(2000);
					return action === "stop" ? "stop" : "continue";
				},
			}).catch((error: unknown) => error);
			expect(observed).toBe("EXTERNAL_DEATH_OBSERVED\n");
			expect(result).toMatchObject({ code: "READ_FAILED" });
			expect(native ? await native.exited : null).not.toBeNull();
			expect(native?.signalCode).toBe(end.code === null ? end.signal : null);
			expect(sent).toEqual([]);
			expect(scheduled.mock.calls.map((call) => call[1])).toEqual([2000]);
			scheduled.mockRestore();
		},
	);

test.each(["stop", "abort", "budget"] as const)(
	"TERM of a child alive at the check remains a valid %s retirement",
	async (action) => {
		const abort = new AbortController();
		const time = manualClock();
		const scheduled = spyOn(time.clock, "setTimeout");
		let native: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
		const sent: string[] = [];
		const result = await scanJournal({
			...scanInput,
			clock: time.clock,
			signal: abort.signal,
			spawn() {
				native = Bun.spawn(
					[
						"python3",
						"-u",
						"-c",
						`import sys\nsys.stdout.write(${JSON.stringify(journalLine())});sys.stdout.flush()\nsys.stdin.readline()`,
					],
					{ env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
				);
				const child = native;
				return {
					pid: child.pid,
					stdout: child.stdout,
					stderr: child.stderr,
					exited: child.exited,
					get signalCode() {
						return child.signalCode;
					},
					get exitCode() {
						return child.exitCode;
					},
					get killed() {
						return child.killed;
					},
					kill(signal) {
						sent.push(signal);
						child.kill(signal);
					},
				};
			},
			onRecord() {
				if (action === "abort") abort.abort();
				if (action === "budget") time.advance(2000);
				return action === "stop" ? "stop" : "continue";
			},
		});
		expect(result).toMatchObject({
			status: action === "budget" ? "budget" : "stopped",
			exitCode: 143,
		});
		expect(native?.signalCode).toBe("SIGTERM");
		expect(sent).toEqual(["SIGTERM"]);
		expect(scheduled.mock.calls.map((call) => call[1])).toEqual([2000, 100]);
		scheduled.mockRestore();
	},
);

for (const mode of [
	"owned KILL",
	"owned TERM already dead",
	"external HUP after TERM",
] as const)
	test.each(["stop", "abort", "budget"] as const)(
		`${mode} preserves causal ownership during %s escalation`,
		async (action) => {
			const abort = new AbortController();
			const time = manualClock();
			const scheduled = spyOn(time.clock, "setTimeout");
			const sent: string[] = [];
			let native: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
			let killedWhileAlive: boolean | undefined;
			const result = await scanJournal({
				...scanInput,
				clock: time.clock,
				signal: abort.signal,
				spawn() {
					const script = [
						"import sys,signal",
						mode === "owned TERM already dead"
							? ""
							: "signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGTERM})",
						`sys.stdout.write(${JSON.stringify(journalLine())});sys.stdout.flush()`,
						"sys.stdin.readline()",
					]
						.filter(Boolean)
						.join("\n");
					native = Bun.spawn(["python3", "-u", "-c", script], {
						env: process.env,
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					});
					const child = native;
					return {
						pid: child.pid,
						stdout: child.stdout,
						stderr: child.stderr,
						exited: child.exited,
						get signalCode() {
							return child.signalCode;
						},
						get exitCode() {
							return child.exitCode;
						},
						get killed() {
							return child.killed;
						},
						kill(signal) {
							sent.push(signal);
							child.kill(signal);
							if (signal !== "SIGTERM") return;
							if (mode === "owned KILL") killedWhileAlive = child.killed;
							else
								execFileSync(
									"python3",
									[
										"-c",
										[
											"import os,signal,select,sys",
											"fd=os.pidfd_open(int(sys.argv[1]))",
											mode === "external HUP after TERM"
												? "signal.pidfd_send_signal(fd,signal.SIGHUP)"
												: "",
											"poll=select.poll();poll.register(fd,select.POLLIN);poll.poll()",
										]
											.filter(Boolean)
											.join("\n"),
										String(child.pid),
									],
									{ timeout: 3000 },
								);
							queueMicrotask(() => time.advance(100));
						},
					};
				},
				onRecord() {
					if (action === "abort") abort.abort();
					if (action === "budget") time.advance(2000);
					return action === "stop" ? "stop" : "continue";
				},
			}).catch((error: unknown) => error);
			if (mode === "external HUP after TERM")
				expect(result).toMatchObject({ code: "READ_FAILED" });
			else
				expect(result).toMatchObject({
					status: action === "budget" ? "budget" : "stopped",
					exitCode: mode === "owned KILL" ? 137 : 143,
				});
			expect(native ? await native.exited : null).not.toBeNull();
			expect(sent).toEqual(
				mode === "owned KILL" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"],
			);
			if (mode === "owned KILL") expect(killedWhileAlive).toBe(false);
			expect(scheduled.mock.calls.map((call) => call[1])).toEqual([2000, 100]);
			scheduled.mockRestore();
		},
	);
