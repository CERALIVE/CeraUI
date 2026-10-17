import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { addonDisable, addonEnable } from "../helpers/addon-helper.ts";
import { SpawnTimeoutError } from "../helpers/bounded-spawn.ts";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { groupProcessFixture } from "./helpers/group-process-fixture.ts";
import { completionFixture } from "./helpers/sysext-completion-fixture.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof completionFixture>;
beforeEach(() => {
	f = completionFixture();
});
afterEach(() => f.reset());
for (const action of ["enable", "disable"] as const) {
	for (const actor of ["systemctl", action === "enable" ? "install" : "rm"]) {
		test(`unchanged Bash ${action} keeps its orphan ${actor} held before descriptor settlement`, async () => {
			const p = await groupProcessFixture(`script:${action}:${actor}`);
			let probes = 0;
			const unitProbe = spyOn(
				spawnPolicy,
				"spawnWithTimeout",
			).mockImplementation(async () => {
				probes++;
				return {
					exitCode: 0,
					stdout: "Job=0\nActiveState=inactive\nSubState=dead\n",
					stderr: "",
				};
			});
			const deps = {
				isRealDevice: async () => true,
				readDescriptor: async () => sysextDescriptor,
				exec: () => p.step.run(),
				createStep: () => p.step,
			};
			const work = (
				action === "enable"
					? addonEnable("cog-display", deps)
					: addonDisable("cog-display", deps)
			).catch((error: unknown) => error);
			try {
				const worker = await p.worker();
				expect(worker).toMatchObject({
					pgid: p.step.child()?.pid,
					sid: p.step.child()?.pid,
				});
				p.fire(30000);
				await p.step.child()?.exited;
				await p.fireWhenScheduled(50);
				const result = await work;
				expect(result).toBeInstanceOf(SpawnTimeoutError);
				expect(result).toMatchObject({ code: 143 });
				expect(isDisruptiveActionPending()).toBe(true);
				expect(probes).toBe(0);
			} finally {
				unitProbe.mockRestore();
				await p.cleanup();
			}
		}, 15000);
	}
}
