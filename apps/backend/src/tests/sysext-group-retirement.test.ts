import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	addonDisable,
	addonEnable,
	addonRefresh,
} from "../helpers/addon-helper.ts";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { helperStepFixture } from "./helpers/helper-step-fixture.ts";
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
	for (const actor of [
		"systemctl",
		action === "enable" ? "install" : "rm",
	] as const) {
		for (const code of [0, 1, 137, 143]) {
			test(`${action} exit ${code} retains its surviving ${actor} before any descriptor probe or refresh`, async () => {
				// Given a real helper wrapper whose unchanged helper left an ordinary child.
				f.rows["42"] =
					`${actor}\0${action === "enable" ? "start" : "stop"}\0kiosk.service\0`;
				f.executables["42"] = `/usr/bin/${actor}`;
				const units: string[] = [];
				const unitProbe = spyOn(
					spawnPolicy,
					"spawnWithTimeout",
				).mockImplementation(async (argv) => {
					units.push(argv[argv.length - 1] ?? "");
					return {
						exitCode: 0,
						stderr: "",
						stdout: "Job=0\nActiveState=inactive\nSubState=dead\n",
					};
				});
				const original = Object.assign(new Error("helper exit"), {
					code,
					stdout: "partial-out",
					stderr: "partial-err",
				});
				let refreshes = 0;
				const deps = {
					isRealDevice: async () => true,
					readDescriptor: async () => sysextDescriptor,
					exec: async (_file: string, args: readonly string[]) => {
						if (args.includes("refresh")) {
							refreshes++;
							return { stdout: "refresh", stderr: "" };
						}
						if (code) throw original;
						return { stdout: "helper-ok", stderr: "" };
					},
				};
				const contained = {
					...deps,
					createStep: (args: readonly string[]) =>
						helperStepFixture(
							() => deps.exec("sudo", ["ceralive-addon-helper", ...args]),
							() => undefined,
						),
				};
				try {
					// When the production wrapper/seam/resolver sees that outcome.
					const result = await (action === "enable"
						? addonEnable("cog-display", contained)
						: addonDisable("cog-display", contained)
					).catch((error: unknown) => error);
					await evidenceJobs();
					// Then neither a success nor any small/signal exit retires descendants.
					expect(result).toBe(code ? original : "helper-ok");
					expect(isDisruptiveActionPending()).toBe(true);
					expect(getDisruptiveActionDecision()).toEqual({
						allowed: false,
						reason: "update_in_progress",
					});
					expect(units).toEqual([]);
					await expect(addonRefresh(contained)).rejects.toMatchObject({
						reason: "update_in_progress",
					});
					expect(refreshes).toBe(0);
				} finally {
					unitProbe.mockRestore();
				}
			});
		}
	}
}
