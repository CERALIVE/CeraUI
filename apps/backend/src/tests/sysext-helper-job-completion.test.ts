import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { addonDisable, addonEnable } from "../helpers/addon-helper.ts";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	completionFixture,
	evidenceJobs,
} from "./helpers/sysext-completion-fixture.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof completionFixture>;
beforeEach(() => {
	f = completionFixture();
});
afterEach(() => f.reset());

for (const action of ["enable", "disable"] as const) {
	test(`helper ${action} owns descriptor jobs after its client disappears`, async () => {
		// Given no helper actor but a descriptor-owned kiosk job still in systemd.
		let settled = false;
		const units: string[] = [];
		const probe = spyOn(spawnPolicy, "spawnWithTimeout").mockImplementation(
			async (argv) => {
				units.push(argv.at(-1) ?? "");
				return {
					exitCode: 0,
					stderr: "",
					stdout: settled
						? "Job=0\nActiveState=inactive\nSubState=dead\n"
						: "Job=9\nActiveState=activating\nSubState=start\n",
				};
			},
		);
		const deps = {
			isRealDevice: async () => true,
			readDescriptor: async () => sysextDescriptor,
			exec: async () => {
				throw new Error("uncertain helper client");
			},
		};
		try {
			// When the real wrapper, seam and resolver handle the failed client.
			await (action === "enable"
				? addonEnable("cog-display", deps)
				: addonDisable("cog-display", deps)
			).catch(() => undefined);
			await evidenceJobs();
			// Then actor absence alone cannot release; the actual job must settle.
			expect(isDisruptiveActionPending()).toBe(true);
			expect(getDisruptiveActionDecision()).toEqual({
				allowed: false,
				reason: "update_in_progress",
			});
			expect(units).toEqual(["kiosk.service"]);
			settled = true;
			await f.wake();
			expect(isDisruptiveActionPending()).toBe(false);
			expect(units).toEqual(["kiosk.service", "kiosk.service"]);
		} finally {
			probe.mockRestore();
		}
	});
}

test("unreadable descriptor prevents helper submission instead of borrowing an empty unit set", async () => {
	// Given descriptor evidence unavailable under the wrapper's identity.
	const calls: string[] = [];
	const error = Object.assign(new Error("descriptor unavailable"), {
		code: "EACCES",
	});
	const deps = {
		isRealDevice: async () => true,
		readDescriptor: async () => {
			throw error;
		},
		exec: async () => {
			calls.push("helper");
			return { stdout: "{}", stderr: "" };
		},
	};
	// When enable is requested through the real wrapper.
	const result = await addonEnable("cog-display", deps).catch(
		(caught: unknown) => caught,
	);
	// Then no submitted effect requires an invented completion proof.
	expect(result).toBe(error);
	expect(calls).toEqual([]);
	expect(isDisruptiveActionPending()).toBe(false);
});
