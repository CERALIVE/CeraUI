import { expect, test } from "bun:test";
import {
	createSoftwareUpdateProcessMonitor,
	getUpdateState,
	resetSoftwareUpdateState,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

for (const permission of ["yes", "no", "unknown"] as const) {
	for (const boot of ["same", "new"] as const) {
		test(`package success is installation evidence with restart ${permission} on ${boot} boot`, async () => {
			// Given the real monitor and restart boundary with a controlled durable permission.
			await using h = await updateHarness();
			h.completion = Promise.resolve(0);
			const entered = Promise.withResolvers<void>();
			const permissionReply = Promise.withResolvers<boolean>();
			if (permission !== "unknown")
				permissionReply.resolve(permission === "yes");
			startSoftwareUpdate();
			const finished = createSoftwareUpdateProcessMonitor().finish(
				Promise.resolve(0),
				() => {
					entered.resolve();
					return permissionReply.promise;
				},
			);
			// When APT completes, then the actual wire success does not depend on restart permission.
			await finished;
			await entered.promise;
			expect(getUpdateState().kind).toBe("success");
			if (permission === "yes") await h.restarted();
			else await Promise.resolve();
			expect(h.restarts).toBe(permission === "yes" ? 1 : 0);
			if (boot === "new") {
				resetSoftwareUpdateState();
				expect(getUpdateState().kind).not.toBe("success");
			}
			if (permission === "unknown") {
				permissionReply.resolve(false);
				await Promise.resolve();
			}
		});
	}
}
