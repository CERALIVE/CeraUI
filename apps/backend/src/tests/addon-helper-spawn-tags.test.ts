import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAddonHelperStep } from "../helpers/addon-helper-step.ts";
import { setSysextEvidenceForTest } from "../modules/addons/disruptive-sysext-step.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { cancelDisruptiveRetries } from "../modules/system/disruptive-retry.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	helperDispatchFixture,
	invokeHelperAction,
} from "./helpers/helper-dispatch-fixture.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof helperDispatchFixture>;
beforeEach(() => {
	f = helperDispatchFixture();
});
afterEach(() => f.reset());

for (const action of ["enable", "disable", "refresh"] as const) {
	for (const syscall of ["socketpair", "fcntl", "posix_spawn"] as const) {
		for (const code of [
			"EMFILE",
			"ENFILE",
			"ENOMEM",
			"EAGAIN",
			"ENOENT",
			"E2BIG",
		] as const) {
			test(`${action} proven pre-exec ${syscall} ${code} releases without evidence probes`, async () => {
				// Given literal Bun errno/tag inputs that source places before exec.
				const original = Object.assign(new Error("pre-exec failure"), {
					code,
					syscall,
				});
				let signals = 0,
					reads = 0;
				setSysextEvidenceForTest({
					procIo: {
						read: async () => {
							reads++;
							throw new Error("forbidden census");
						},
						list: async () => [],
						link: async () => "",
					},
					probe: async (scope) => {
						f.units.push(scope.unit);
						return "completed";
					},
				});
				const step = createAddonHelperStep([action], {
					euid: () => 0,
					checkLauncher: () => undefined,
					spawn: () => {
						throw original;
					},
					kill: () => {
						signals++;
					},
				});
				// When the production action fails before helper exec.
				const result = await invokeHelperAction(action, {
					isRealDevice: async () => true,
					exec: async () => ({ stdout: "", stderr: "" }),
					readDescriptor: async () => sysextDescriptor,
					createStep: () => step,
				}).catch((error: unknown) => error);
				// Then original failure and zero-probe immediate release are preserved.
				expect(result).toBe(original);
				expect(step.dispatch()).toBe("none");
				expect(signals).toBe(0);
				expect(reads).toBe(0);
				expect(f.units).toEqual([]);
				expect(f.delays).toEqual([]);
				expect(isDisruptiveActionPending()).toBe(false);
			});
		}
	}
	for (const kind of [
		"untagged",
		"unknown",
		"non-Error",
		"abort in catch",
	] as const) {
		test(`${action} handle-less ${kind} with empty census settles promptly but cannot bypass units`, async () => {
			// Given no live actors, but no source-proven no-dispatch error either.
			const original =
				kind === "non-Error"
					? { code: "EACCES", syscall: "posix_spawn" }
					: kind === "unknown"
						? Object.assign(new Error("unknown"), {
								syscall: "pipe",
								code: "EMFILE",
							})
						: Object.assign(new Error("untagged"), { code: "EACCES" });
			let settled = false,
				reads = 0;
			setSysextEvidenceForTest({
				procIo: {
					read: async () => {
						reads++;
						return "/sbin/init\0";
					},
					list: async () => ["1"],
					link: async () => "/sbin/init",
				},
				probe: async (scope) => {
					f.units.push(scope.unit);
					return settled ? "completed" : "in-flight";
				},
			});
			const step = createAddonHelperStep([action], {
				euid: () => 0,
				checkLauncher: () => undefined,
				kill: () => {
					throw new Error("no PGID");
				},
				spawn: () => {
					if (kind === "abort in catch") cancelDisruptiveRetries();
					throw original;
				},
			});
			// When the real reservation handles the unknown launch outcome.
			const result = await invokeHelperAction(action, {
				isRealDevice: async () => true,
				exec: async () => ({ stdout: "", stderr: "" }),
				readDescriptor: async () => sysextDescriptor,
				createStep: () => step,
			}).catch((error: unknown) => error);
			// Then unknown is retained as evidence; only positive census plus units clear it.
			expect(result).toBe(original);
			expect(step.dispatch()).toBe("unknown");
			if (kind === "abort in catch") {
				expect(isDisruptiveActionPending()).toBe(true);
				expect(reads).toBe(0);
				expect(f.delays).toEqual([]);
			} else {
				expect(reads).toBeGreaterThan(0);
				if (action !== "refresh") {
					expect(isDisruptiveActionPending()).toBe(true);
					expect(f.units).toEqual(["kiosk.service"]);
					expect(f.delays).toEqual([2000]);
					settled = true;
					await f.wakeups[0]?.();
				}
				expect(isDisruptiveActionPending()).toBe(false);
			}
		});
	}
}
