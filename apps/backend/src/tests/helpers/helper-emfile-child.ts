import { expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { addonRefresh } from "../../helpers/addon-helper.ts";
import { createAddonHelperStep } from "../../helpers/addon-helper-step.ts";
import { isDisruptiveActionPending } from "../../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../../modules/system/disruptive-action-runtime.ts";
import { sysextDescriptor } from "../sysext-action-fixture.ts";
import { useSessionOwnerForFile } from "./bind-session-owner.ts";
import {
	helperDispatchFixture,
	invokeHelperAction,
	launchErrno,
} from "./helper-dispatch-fixture.ts";

useSessionOwnerForFile();
for (const action of ["enable", "disable", "refresh"] as const) {
	test(`real EMFILE ${action} leaves no reservation after descriptor cleanup`, async () => {
		// Given loaded production modules before a real per-process resource limit bites.
		const f = helperDispatchFixture();
		let original: unknown,
			attempts = 0,
			signals = 0,
			opened = 0;
		const step = createAddonHelperStep([action, "cog-display"], {
			euid: () => 0,
			checkLauncher: () => undefined,
			spawn: (_argv, options) => {
				const fds: number[] = [];
				try {
					for (let index = 0; index < 128; index++) {
						try {
							fds.push(openSync("/dev/null", "r"));
						} catch (error) {
							if (
								!(
									error instanceof Error &&
									"code" in error &&
									error.code === "EMFILE"
								)
							)
								throw error;
							break;
						}
					}
					opened = fds.length;
					attempts++;
					// Redirect only the executable to a harmless control; use real Bun pipe setup.
					return Bun.spawn(["/usr/bin/true"], options);
				} catch (error) {
					original = error;
					throw error;
				} finally {
					for (const fd of fds) closeSync(fd);
				}
			},
			kill: () => {
				signals++;
			},
		});
		const exec = async () => ({ stdout: "", stderr: "" });
		try {
			// When the actual wrapper/runner fails, spawn's finally has already closed all fds.
			const result = await invokeHelperAction(action, {
				isRealDevice: async () => true,
				exec,
				readDescriptor: async () => sysextDescriptor,
				createStep: () => step,
			}).catch((error: unknown) => error);
			// Then no resources remain exhausted and there is positively no dispatched work.
			expect(result).toBe(original);
			expect(result).toMatchObject({ code: "EMFILE" });
			expect(attempts).toBe(1);
			expect(opened).toBeGreaterThan(0);
			expect(step.spawned()).toBe(false);
			process.stdout.write(
				`REAL_EMFILE ${action} descriptors_closed=${opened} spawn_attempts=${attempts}\n`,
			);
			expect(signals).toBe(0);
			expect(f.units).toEqual([]);
			expect(f.delays).toEqual([]);
			expect(isDisruptiveActionPending()).toBe(false);
			expect(getDisruptiveActionDecision()).toEqual({ allowed: true });
			const repaired = createAddonHelperStep(["refresh"], {
				euid: () => 0,
				checkLauncher: () => undefined,
				spawn: (_argv, options) => Bun.spawn(["/usr/bin/true"], options),
				kill: () => {
					throw launchErrno("ESRCH");
				},
			});
			expect(
				await addonRefresh({
					isRealDevice: async () => true,
					exec,
					createStep: () => repaired,
				}),
			).toBe("");
		} finally {
			f.reset();
		}
	});
}
