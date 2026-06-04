/*
 * RED-first repro for the journalctl command injection in logs.ts (Task 9).
 *
 * Pre-fix, getLog() builds a SHELL STRING `journalctl -b -u ${service}` and
 * hands it to exec(). A `service` value of "ssh; touch /tmp/pwned" is split by
 * the shell at the `;` into two commands, so the attacker-controlled
 * `touch /tmp/pwned` runs with the backend's privileges.
 *
 * The security property under test:
 *  - getLog() must invoke the argv-only run() helper with the service value as a
 *    SINGLE intact argv element (no shell, so `;`/spaces are inert);
 *  - the injected `touch /tmp/pwned` must therefore NEVER execute.
 *
 * Pre-fix this FAILS: getLog uses exec() (run() is never called) and the real
 * shell creates /tmp/pwned. Post-fix it passes (run() argv, no shell).
 */

import { existsSync, rmSync } from "node:fs";

import { logInputSchema } from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import * as runModule from "../helpers/run.ts";
import { getLog } from "../modules/system/logs.ts";

const PWNED = "/tmp/pwned";
const MALICIOUS = "ssh; touch /tmp/pwned";

/** Minimal WebSocket stand-in: getSocketSenderId reads `data.senderId`. */
function fakeConn() {
	return { send: () => {}, data: { senderId: "test" } } as never;
}

function cleanup() {
	try {
		rmSync(PWNED, { force: true });
	} catch {
		/* ignore */
	}
}

beforeEach(cleanup);
afterEach(() => {
	cleanup();
	mock.restore();
});

describe("logs.ts getLog() — journalctl command injection", () => {
	it("invokes run() with journalctl argv — service is ONE intact element, no shell", async () => {
		const runSpy = spyOn(runModule, "run").mockResolvedValue("log-output");

		await getLog(fakeConn(), MALICIOUS);
		// Allow any (pre-fix) real exec() callback to fire before asserting.
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(runSpy).toHaveBeenCalledTimes(1);
		const [bin, args, opts] = runSpy.mock.calls[0] as [
			string,
			string[],
			{ maxBuffer: number },
		];
		expect(bin).toBe("journalctl");
		// The malicious string is a single argv token — NOT split on ';'.
		expect(args).toEqual(["-b", "-u", MALICIOUS]);
		expect(args[2]).toBe(MALICIOUS);
		// 10 MiB ceiling preserved from the original exec() call.
		expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
	});

	it("does NOT execute the injected `touch /tmp/pwned` (no shell interpretation)", async () => {
		spyOn(runModule, "run").mockResolvedValue("log-output");

		await getLog(fakeConn(), MALICIOUS);
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(existsSync(PWNED)).toBe(false);
	});
});

describe("oRPC boundary — Zod SERVICE_RE on the log `service` input", () => {
	it("rejects a malicious service string before it can reach getLog()", () => {
		expect(logInputSchema.safeParse({ service: MALICIOUS }).success).toBe(false);
		expect(logInputSchema.safeParse({ service: "ssh && reboot" }).success).toBe(
			false,
		);
		expect(logInputSchema.safeParse({ service: "$(reboot)" }).success).toBe(
			false,
		);
	});

	it("accepts legitimate systemd unit names and absent input", () => {
		expect(logInputSchema.safeParse({ service: "ssh.service" }).success).toBe(
			true,
		);
		expect(
			logInputSchema.safeParse({ service: "getty@tty1.service" }).success,
		).toBe(true);
		expect(logInputSchema.safeParse({}).success).toBe(true);
		expect(logInputSchema.safeParse(undefined).success).toBe(true);
	});
});
