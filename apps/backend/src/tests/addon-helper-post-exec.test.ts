import { expect, test } from "bun:test";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { cancelDisruptiveRetries } from "../modules/system/disruptive-retry.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { invokeHelperAction } from "./helpers/helper-dispatch-fixture.ts";
import { helperPostExecFixture } from "./helpers/helper-post-exec-fixture.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
const faults = [
	Object.assign(new Error("pidfd fault"), {
		code: "EMFILE",
		syscall: "pidfd_open",
	}),
	Object.assign(new Error("pidfd fault"), {
		code: "ENOMEM",
		syscall: "pidfd_open",
	}),
	Object.assign(new Error("pidfd fault"), {
		code: "ENFILE",
		syscall: "pidfd_open",
	}),
	Object.assign(new Error("untagged fault"), { code: "EMFILE" }),
	Object.assign(new Error("unknown tag"), {
		code: "EACCES",
		syscall: "future_spawn_step",
	}),
	{ code: "EMFILE", syscall: "pidfd_open" },
] as const;

for (const action of ["enable", "disable", "refresh"] as const) {
	for (const [index, original] of faults.entries()) {
		test(`${action} post-exec fault ${index} retains its real survivor then settles group and descriptor jobs`, async () => {
			// Given a ready real survivor, with the leader reaped before the spawn port throws.
			const f = await helperPostExecFixture(original);
			const step = f.createStep(
				action === "refresh" ? [action] : [action, "cog-display"],
			);
			try {
				// When the actual wrapper/runner/collector boundary rejects without a handle.
				const result = await invokeHelperAction(action, {
					isRealDevice: async () => true,
					exec: async () => ({ stdout: "", stderr: "" }),
					readDescriptor: async () => sysextDescriptor,
					createStep: () => step,
				}).catch((error: unknown) => error);
				// Then unknown dispatch must not admit any competing disruptive effect.
				expect(result).toBe(original);
				expect(step.child()).toBeUndefined();
				expect(step.dispatch()).toBe("unknown");
				expect(f.alive()).toBe(true);
				expect(f.pgid()).toBeGreaterThan(1);
				expect(f.signals()).toBeGreaterThan(0);
				expect(f.reads()).toBe(0);
				expect(f.units).toEqual([]);
				expect(isDisruptiveActionPending()).toBe(true);
				expect(getDisruptiveActionDecision()).toEqual({
					allowed: false,
					reason: "update_in_progress",
				});
				expect(f.delays).toEqual([2000]);
				await f.retire();
				await f.wakeups[0]?.();
				if (action !== "refresh") {
					expect(f.units).toEqual(["kiosk.service"]);
					expect(isDisruptiveActionPending()).toBe(true);
					f.settleUnits();
					await f.wakeups[1]?.();
				}
				expect(isDisruptiveActionPending()).toBe(false);
				expect(getDisruptiveActionDecision()).toEqual({ allowed: true });
			} finally {
				await f.cleanup();
			}
		}, 45000);
	}

	test(`${action} handle-less unknown survivor holds with capped cancellable backoff and no spin`, async () => {
		// Given a live survivor that does not retire during any controlled observation.
		const f = await helperPostExecFixture(
			Object.assign(new Error("pidfd fault"), {
				code: "ENOMEM",
				syscall: "pidfd_open",
			}),
		);
		try {
			const step = f.createStep([action, "cog-display"]);
			// When the production resolver retries ten times without completion evidence.
			await invokeHelperAction(action, {
				isRealDevice: async () => true,
				exec: async () => ({ stdout: "", stderr: "" }),
				readDescriptor: async () => sysextDescriptor,
				createStep: () => step,
			}).catch((error: unknown) => error);
			for (let n = 0; n < 9; n++) await f.wakeups[n]?.();
			// Then the hold never clears on elapsed time; cancellation schedules no late work.
			expect(f.delays).toEqual([
				2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000,
			]);
			expect(isDisruptiveActionPending()).toBe(true);
			expect(f.units).toEqual([]);
			const reads = f.reads();
			cancelDisruptiveRetries();
			await f.wakeups[9]?.();
			expect(f.reads()).toBe(reads);
			expect(f.delays).toHaveLength(10);
			expect(isDisruptiveActionPending()).toBe(true);
		} finally {
			await f.cleanup();
		}
	}, 45000);
}
