import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	requestCompletionReboot,
	resetCompletionRebootForTest,
} from "../modules/system/deferred-completion-reboot.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { setDisruptiveRetryClockForTest } from "../modules/system/disruptive-retry.ts";
import { markBootDegraded } from "../modules/system/readiness.ts";
import * as updates from "../modules/system/software-updates.ts";
import * as runtime from "../modules/system/update-orchestrator/runtime.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { sysextFixture } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let fixture: ReturnType<typeof sysextFixture>;
let wakeups: Array<() => Promise<void>>;
beforeEach(() => {
	fixture = sysextFixture();
	wakeups = [];
	setDisruptiveRetryClockForTest({
		schedule: (run) => {
			wakeups.push(run);
			return () => undefined;
		},
	});
});
afterEach(() => {
	resetCompletionRebootForTest();
	setDisruptiveRetryClockForTest(null);
	fixture.reset();
});

for (const reason of ["maintenance", "package-install"] as const) {
	test(`completion reboot shares ${reason} refusal and retries without superseding it`, async () => {
		// Given current common-gate authority that the old copied gate omitted.
		let busy = true;
		const authority = spyOn(
			runtime,
			"isDisruptiveUpdateAuthoritySettled",
		).mockImplementation(() => !busy);
		const updating = spyOn(updates, "isUpdating").mockImplementation(
			() => reason === "package-install" && busy,
		);
		if (reason === "maintenance")
			markBootDegraded("update-orchestrator-maintenance");
		const calls: string[] = [];
		try {
			expect(getDisruptiveActionDecision()).toEqual({
				allowed: false,
				reason: "update_in_progress",
			});
			// When completion requests reboot, repeats while busy, then authority settles.
			requestCompletionReboot(() => {
				calls.push("reboot");
			});
			expect(calls).toEqual([]);
			expect(isDisruptiveActionPending()).toBe(false);
			const first = wakeups.shift();
			if (!first) throw new Error("missing deferred retry");
			await first();
			expect(calls).toEqual([]);
			busy = false;
			const next = wakeups.shift();
			if (!next) throw new Error("missing settled retry");
			await next();
			// Then exactly one allowed submission keeps the shutdown exclusion.
			expect(calls).toEqual(["reboot"]);
			expect(isDisruptiveActionPending()).toBe(true);
			expect(wakeups).toEqual([]);
		} finally {
			authority.mockRestore();
			updating.mockRestore();
		}
	});
}
