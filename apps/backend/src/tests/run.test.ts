/*
 * Tests for the typed, argv-only OS command runner (helpers/run.ts) — the
 * security foundation that all Wave 2 hardening tasks import.
 *
 * The properties under test are security-critical:
 *  - only allowlisted binaries may run;
 *  - argv is passed through verbatim with NO shell, so shell metacharacters in
 *    an argument are inert (a single argv element, never re-parsed);
 *  - maxBuffer is honored / forwarded to execFile;
 *  - argMatch() validates dynamic values and rejects leading-dash injection;
 *  - runWithStdin() keeps the secret in stdin and never on argv.
 */

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import * as execMod from "../helpers/exec.ts";
import {
	ALLOWED,
	argMatch,
	DEFAULT_MAX_BUFFER,
	ID_RE,
	run,
	runWithStdin,
	SERVICE_RE,
} from "../helpers/run.ts";

afterEach(() => {
	mock.restore();
});

describe("run() — allowlist enforcement", () => {
	it("resolves for an allowlisted binary (nmcli -v) without touching a shell", async () => {
		const spy = spyOn(execMod, "execFileP").mockResolvedValue({
			stdout: "nmcli tool, version 1.0\n",
			stderr: "",
		} as never);

		const out = await run("nmcli", ["-v"]);

		expect(out).toBe("nmcli tool, version 1.0\n");
		expect(spy).toHaveBeenCalledTimes(1);
		// argv-only: (bin, args, opts) — no `sh -c`, no command string.
		const [bin, args] = spy.mock.calls[0] as [string, string[], unknown];
		expect(bin).toBe("nmcli");
		expect(args).toEqual(["-v"]);
	});

	it("throws 'not allowlisted' for a binary outside the allowlist (rm -rf /)", async () => {
		const spy = spyOn(execMod, "execFileP").mockResolvedValue({
			stdout: "",
			stderr: "",
		} as never);

		await expect(run("rm", ["-rf", "/"])).rejects.toThrow(
			"binary not allowlisted: rm",
		);
		// The dangerous binary must never reach execFile.
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("run() — argv pass-through (no shell interpretation)", () => {
	it("passes a shell-metacharacter argument as ONE argv element", async () => {
		const spy = spyOn(execMod, "execFileP").mockResolvedValue({
			stdout: "",
			stderr: "",
		} as never);

		const injection = "a; rm -rf /";
		await run("journalctl", ["-u", injection]);

		expect(spy).toHaveBeenCalledTimes(1);
		const [bin, args] = spy.mock.calls[0] as [string, string[], unknown];
		expect(bin).toBe("journalctl");
		// The injection string is a single, intact argv element — not split, not
		// expanded, not handed to a shell.
		expect(args).toEqual(["-u", injection]);
		expect(args[1]).toBe("a; rm -rf /");
	});

	it("honors a caller-supplied maxBuffer and defaults otherwise", async () => {
		const spy = spyOn(execMod, "execFileP").mockResolvedValue({
			stdout: "",
			stderr: "",
		} as never);

		await run("ip", ["addr"], { maxBuffer: 1234 });
		let opts = spy.mock.calls[0]?.[2] as { maxBuffer: number };
		expect(opts.maxBuffer).toBe(1234);

		await run("ip", ["addr"]);
		opts = spy.mock.calls[1]?.[2] as { maxBuffer: number };
		expect(opts.maxBuffer).toBe(DEFAULT_MAX_BUFFER);
	});
});

describe("argMatch() — dynamic argument validation", () => {
	it("accepts a valid service name and returns it unchanged", () => {
		expect(argMatch(SERVICE_RE, "ssh.service")).toBe("ssh.service");
		expect(argMatch(SERVICE_RE, "getty@tty1.service")).toBe(
			"getty@tty1.service",
		);
	});

	it("rejects a service name containing shell metacharacters", () => {
		expect(() => argMatch(SERVICE_RE, "a;b")).toThrow("invalid argument: a;b");
		expect(() => argMatch(SERVICE_RE, "a b")).toThrow();
		expect(() => argMatch(SERVICE_RE, "$(reboot)")).toThrow();
	});

	it("accepts a valid identifier (ID_RE) and rejects leading-dash injection", () => {
		expect(argMatch(ID_RE, "eth0")).toBe("eth0");
		expect(argMatch(ID_RE, "wwan0.1")).toBe("wwan0.1");
		// Starts with '-': could be mis-parsed as a flag → must be rejected even
		// though every character is otherwise allowed.
		expect(() => argMatch(ID_RE, "--help")).toThrow("invalid argument: --help");
		expect(() => argMatch(ID_RE, "-rf")).toThrow();
	});
});

describe("runWithStdin() — secret stays in stdin, never on argv", () => {
	it("writes the secret to child.stdin and keeps it out of argv", async () => {
		const childProcess = await import("node:child_process");

		const stdinWrites: string[] = [];
		const fakeChild = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			stdin: { write: (d: string) => boolean; end: () => void };
		};
		fakeChild.stdout = new EventEmitter();
		fakeChild.stderr = new EventEmitter();
		fakeChild.stdin = {
			write: (d: string) => {
				stdinWrites.push(d);
				return true;
			},
			end: () => {
				// Simulate a clean exit once stdin is closed.
				queueMicrotask(() => fakeChild.emit("close", 0));
			},
		};

		const spy = spyOn(childProcess, "spawn").mockReturnValue(
			fakeChild as never,
		);

		const secret = "pw\npw\n";
		await runWithStdin("passwd", ["user"], secret);

		expect(spy).toHaveBeenCalledTimes(1);
		const [bin, args] = spy.mock.calls[0] as [string, string[], unknown];
		expect(bin).toBe("passwd");
		expect(args).toEqual(["user"]);

		// The secret must NEVER appear in argv (process table leak).
		expect(args).not.toContain(secret);
		expect(args.join(" ")).not.toContain("pw");

		// It must appear ONLY in what was written to stdin.
		expect(stdinWrites.join("")).toBe(secret);
		expect(stdinWrites.join("")).toContain("pw");
	});

	it("rejects a non-allowlisted binary before spawning", async () => {
		const childProcess = await import("node:child_process");
		const spy = spyOn(childProcess, "spawn");

		await expect(runWithStdin("sh", ["-c", "x"], "secret")).rejects.toThrow(
			"binary not allowlisted: sh",
		);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("ALLOWED — Wave 2 binary coverage", () => {
	it("includes every binary the Wave 2 hardening tasks depend on", () => {
		for (const bin of [
			"nmcli",
			"mmcli",
			"systemctl",
			"journalctl",
			"ip",
			"apt-get",
			"grep",
			"killall",
			"sensors",
			"ifconfig",
			"passwd",
			"reboot",
			"dmesg",
		]) {
			expect(ALLOWED.has(bin)).toBe(true);
		}
	});
});
