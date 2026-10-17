import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { cancelDisruptiveRetries } from "../modules/system/disruptive-retry.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { invokeHelperAction } from "./helpers/helper-dispatch-fixture.ts";
import {
	HELPER_SURVIVORS,
	helperLostHandleFixture,
} from "./helpers/helper-lost-handle-fixture.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
for (const action of ["enable", "disable", "refresh"] as const) {
	for (const actor of HELPER_SURVIVORS) {
		for (const code of ["EMFILE", "ENOMEM", "ENFILE"] as const) {
			test(`${action} lost ${code} handle holds inherited ${actor} until group and jobs retire`, async () => {
				// Given an unrecognized real tool ready in the real launcher's group.
				const original = Object.assign(new Error("post-exec fault"), {
					code,
					syscall: "pidfd_open",
				});
				const f = await helperLostHandleFixture(original, actor);
				const step = f.createStep(
					action === "refresh" ? [action] : [action, "cog-display"],
				);
				try {
					// When Bun reaps the leader, then throws without a child handle.
					const result = await invokeHelperAction(action, {
						isRealDevice: async () => true,
						exec: async () => ({ stdout: "", stderr: "" }),
						readDescriptor: async () => sysextDescriptor,
						createStep: () => step,
					}).catch((error: unknown) => error);
					// Then real negative-group evidence, never actor names, retains exclusion.
					expect(result).toBe(original);
					expect(step.child()).toBeUndefined();
					expect(step.dispatch()).toBe("unknown");
					expect(f.alive()).toBe(true);
					expect(isDisruptiveActionPending()).toBe(true);
					expect(getDisruptiveActionDecision()).toEqual({
						allowed: false,
						reason: "update_in_progress",
					});
					expect(f.targets).toEqual([-f.pgid()]);
					expect(f.reads()).toBe(0);
					expect(f.units).toEqual([]);
					const identity = await readFile(f.pidfile, "utf8").catch(
						(cause: unknown) => {
							if (
								cause instanceof Error &&
								"code" in cause &&
								cause.code === "ENOENT"
							)
								return null;
							throw cause;
						},
					);
					expect(identity?.trim()).toBe(String(f.pgid()));
					expect(f.delays).toEqual([2000]);
					await f.retire();
					await f.wakeups[0]?.();
					if (action !== "refresh") {
						expect(isDisruptiveActionPending()).toBe(true);
						expect(f.units).toEqual(["kiosk.service"]);
						f.settleUnits();
						await f.wakeups[1]?.();
						expect(f.targets).toEqual([-f.pgid(), -f.pgid()]);
					}
					expect(isDisruptiveActionPending()).toBe(false);
					expect(getDisruptiveActionDecision()).toEqual({ allowed: true });
				} finally {
					await f.cleanup();
				}
			}, 45000);
		}
	}
}

test("recovered identity survives an early file removal and capped cancellation never releases a live group", async () => {
	// Given the launcher identity recovered before an unrelated file disappearance.
	const f = await helperLostHandleFixture(
		Object.assign(new Error("post-exec"), {
			code: "ENOMEM",
			syscall: "pidfd_open",
		}),
	);
	const step = f.createStep(["refresh"]);
	try {
		// When repeated controlled observations see only the still-live group.
		await invokeHelperAction("refresh", {
			isRealDevice: async () => true,
			exec: async () => ({ stdout: "", stderr: "" }),
			createStep: () => step,
		}).catch((error: unknown) => error);
		await rm(f.pidfile);
		for (let n = 0; n < 9; n++) await f.wakeups[n]?.();
		// Then neither absent bytes nor elapsed time clears cached owned authority.
		expect(f.delays).toEqual([
			2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000,
		]);
		expect(isDisruptiveActionPending()).toBe(true);
		expect(f.reads()).toBe(0);
		const targets = [...f.targets];
		cancelDisruptiveRetries();
		await f.wakeups[9]?.();
		expect(f.targets).toEqual(targets);
		expect(f.delays).toHaveLength(10);
		expect(isDisruptiveActionPending()).toBe(true);
	} finally {
		await f.cleanup();
	}
}, 45000);
