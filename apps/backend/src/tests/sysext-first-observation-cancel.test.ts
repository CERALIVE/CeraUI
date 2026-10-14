import { afterEach, beforeEach, expect, test } from "bun:test";
import { addonEnable } from "../helpers/addon-helper.ts";
import { createAddonHelperStep } from "../helpers/addon-helper-step.ts";
import { SpawnAbortError } from "../helpers/bounded-spawn.ts";
import { setSysextEvidenceForTest } from "../modules/addons/disruptive-sysext-step.ts";
import {
	isDisruptiveActionPending,
	resetDisruptiveActionReservationForTest,
} from "../modules/system/disruptive-action-reservation.ts";
import { cancelDisruptiveRetries } from "../modules/system/disruptive-retry.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	helperDispatchFixture,
	launchErrno,
} from "./helpers/helper-dispatch-fixture.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof helperDispatchFixture>;
beforeEach(() => {
	f = helperDispatchFixture();
});
afterEach(() => f.reset());
for (const retired of [false, true]) {
	for (const reply of ["resolve", "reject"] as const) {
		test(`first descriptor ${reply} after ${retired ? "owner retirement" : "cancellation"} schedules zero late retries`, async () => {
			// Given actual group retirement followed by a parked first descriptor observation.
			const observed = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<"unknown">();
			let probes = 0;
			setSysextEvidenceForTest({
				probe: async () => {
					probes++;
					observed.resolve();
					return answer.promise;
				},
			});
			const step = createAddonHelperStep(["enable", "cog-display"], {
				euid: () => 0,
				checkLauncher: () => undefined,
				spawn: (_argv, options) => Bun.spawn(["/usr/bin/true"], options),
				kill: () => {
					throw launchErrno("ESRCH");
				},
			});
			const work = addonEnable("cog-display", {
				isRealDevice: async () => true,
				exec: async () => ({ stdout: "", stderr: "" }),
				readDescriptor: async () => sysextDescriptor,
				createStep: () => step,
			});
			await observed.promise;
			// When the controller/owner retires while that very first await rejects or resolves.
			if (retired) resetDisruptiveActionReservationForTest();
			else cancelDisruptiveRetries();
			if (reply === "reject")
				answer.reject(new SpawnAbortError("descriptor observation"));
			else answer.resolve("unknown");
			expect(await work).toBe("");
			const late = [...f.wakeups];
			for (const callback of late) await callback();
			// Then no retry is scheduled, no late probe runs, and cancellation never clears safety.
			expect(probes).toBe(1);
			expect(isDisruptiveActionPending()).toBe(!retired);
			expect(f.delays).toEqual([]);
			expect(f.wakeups).toEqual([]);
		});
	}
}
