/*
 * Task 6 — RED-first repro for the SSH status async race / partial broadcast.
 *
 * The pre-fix `getSshStatus()` fired two independent `exec(...)` callbacks that
 * each mutated a SHARED status object and each called `handleSshStatus`. That
 * design has two observable defects this suite pins down:
 *
 *   1. RACE / PARTIAL BROADCAST — the broadcast is emitted from whichever
 *      callback completes last, and only if BOTH `active` and `user_pass`
 *      happen to be set by then. The function returns the *cached* value
 *      synchronously and never awaits the probes.
 *
 *   2. SYSTEMCTL-ERROR PATH DROPS THE STATUS — when `systemctl is-active`
 *      fails with anything other than the exact string "inactive\n", the
 *      callback `return`s WITHOUT setting `active`, so the completed object
 *      never satisfies the `active !== undefined` guard and NOTHING is
 *      broadcast (the SSH tile silently goes stale).
 *
 * Both tests drive the refactored, injectable signature
 *   getSshStatus({ systemctlIsActive, readShadow, broadcast })
 * The injected `broadcast` spy is the oracle: the fixed implementation must
 * call it EXACTLY ONCE with a COMPLETE status object. Against the pre-fix code
 * (which ignores the deps argument and calls the real module-level broadcast)
 * the spy is never invoked → these tests FAIL, which is the intended RED state.
 */
import { describe, expect, mock, test } from "bun:test";

import { setup } from "../modules/setup.ts";
import { getSshStatus, type SshStatusDeps } from "../modules/system/ssh.ts";

/** A well-formed /etc/shadow line for `user` with a known crypt hash. */
function shadowLine(user: string): string {
	return `root:!:19000:0:99999:7:::\n${user}:$6$abcd$0123456789hashvalue:19000:0:99999:7:::\n`;
}

describe("getSshStatus — async race / single-broadcast (Task 6)", () => {
	test("broadcasts EXACTLY ONCE with a complete status when both probes succeed", async () => {
		// Distinct user per test keeps the module-level change-guard from
		// suppressing the broadcast regardless of test execution order.
		setup.ssh_user = "alice";

		const broadcast = mock((_status: unknown) => {});
		const deps: Partial<SshStatusDeps> = {
			systemctlIsActive: async () => ({ stdout: "active\n", stderr: "" }),
			readShadow: () => shadowLine("alice"),
			broadcast,
		};

		await getSshStatus(deps);

		// Single, atomic broadcast — never partial, never duplicated.
		expect(broadcast).toHaveBeenCalledTimes(1);

		const status = broadcast.mock.calls[0]?.[0] as {
			user?: string;
			active?: boolean;
			user_pass?: boolean;
		};
		// The object must be COMPLETE: every wire field defined.
		expect(status.user).toBe("alice");
		expect(status.active).toBe(true);
		expect(status.user_pass).toBeDefined();
		expect(typeof status.user_pass).toBe("boolean");
	});

	test("systemctl is-active error → STILL one broadcast with active:false (not missing)", async () => {
		setup.ssh_user = "bob";

		const broadcast = mock((_status: unknown) => {});
		const deps: Partial<SshStatusDeps> = {
			// Simulate a hard systemctl failure (exec rejects).
			systemctlIsActive: async () => {
				throw new Error("systemctl: command failed");
			},
			readShadow: () => shadowLine("bob"),
			broadcast,
		};

		await getSshStatus(deps);

		// The status must still be broadcast exactly once...
		expect(broadcast).toHaveBeenCalledTimes(1);

		const status = broadcast.mock.calls[0]?.[0] as {
			user?: string;
			active?: boolean;
			user_pass?: boolean;
		};
		// ...with `active` explicitly false — NOT left undefined/missing.
		expect(status.active).toBe(false);
		expect(status.user).toBe("bob");
		expect(status.user_pass).toBeDefined();
	});

	test("rejects an unsafe ssh_user (leading dash / argument injection)", async () => {
		setup.ssh_user = "-rf";

		const broadcast = mock((_status: unknown) => {});
		await expect(
			getSshStatus({
				systemctlIsActive: async () => ({ stdout: "active\n", stderr: "" }),
				readShadow: () => shadowLine("-rf"),
				broadcast,
			}),
		).rejects.toThrow();

		expect(broadcast).not.toHaveBeenCalled();
	});
});
