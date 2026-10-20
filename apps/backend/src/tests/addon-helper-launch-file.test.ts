import { afterEach, expect, test } from "bun:test";
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
let f: ReturnType<typeof helperDispatchFixture> | undefined;
afterEach(() => f?.reset());

for (const action of ["enable", "disable", "refresh"] as const) {
	for (const bytes of [null, ""] as const) {
		test(`${action} reaped pidfd failure with ${bytes === null ? "absent" : "empty"} identity releases immediately with the original error`, async () => {
			// Given a reaped launch failure whose launcher never recorded identity.
			f = helperDispatchFixture();
			const original = Object.assign(new Error("pidfd"), {
				code: "EMFILE",
				syscall: "pidfd_open",
			});
			let probes = 0,
				cleanup = 0;
			const ports = {
				euid: () => 0,
				checkLauncher: () => undefined,
				launchFile: {
					prepare: () => "/fixture/launch.pid",
					read: async () => bytes,
					cleanup: () => {
						cleanup++;
					},
				},
				spawn: () => {
					throw original;
				},
				kill: () => {
					probes++;
				},
			};
			const step = createAddonHelperStep([action], ports);
			// When the real wrapper handles the original throw.
			const result = await invokeHelperAction(action, {
				isRealDevice: async () => true,
				exec: async () => ({ stdout: "", stderr: "" }),
				readDescriptor: async () => sysextDescriptor,
				createStep: () => step,
			}).catch((error: unknown) => error);
			// Then no helper ever ran; unit/census/group retries are unnecessary.
			expect(result).toBe(original);
			expect(step.dispatch()).toBe("none");
			expect(isDisruptiveActionPending()).toBe(false);
			expect(probes).toBe(0);
			expect(f.units).toEqual([]);
			expect(f.delays).toEqual([]);
			expect(cleanup).toBe(1);
		});
	}
	for (const bytes of [
		"garbage",
		"1.5\n",
		"0\n",
		"1\n",
		"-42\n",
		"2147483648\n",
		"9007199254740992\n",
		"2".repeat(64),
	] as const) {
		test(`${action} malformed launch identity ${JSON.stringify(bytes)} stays unknown without any group syscall`, async () => {
			// Given readable but invalid authority and a census that would clear.
			f = helperDispatchFixture();
			let probes = 0,
				reads = 0,
				cleanup = 0;
			setSysextEvidenceForTest({
				procIo: {
					list: async () => {
						reads++;
						return ["1"];
					},
					read: async () => "/sbin/init\0",
					link: async () => "/sbin/init",
				},
				probe: async () => "completed",
			});
			const ports = {
				euid: () => 0,
				checkLauncher: () => undefined,
				launchFile: {
					prepare: () => "/fixture/launch.pid",
					read: async () => bytes,
					cleanup: () => {
						cleanup++;
					},
				},
				spawn: () => {
					throw Object.assign(new Error("pidfd"), { syscall: "pidfd_open" });
				},
				kill: () => {
					probes++;
					throw Object.assign(new Error("absent"), { code: "ESRCH" });
				},
			};
			const step = createAddonHelperStep([action], ports);
			// When invalid identity reaches initial and controlled retry observations.
			await invokeHelperAction(action, {
				isRealDevice: async () => true,
				exec: async () => ({ stdout: "", stderr: "" }),
				readDescriptor: async () => sysextDescriptor,
				createStep: () => step,
			}).catch((error: unknown) => error);
			await f.wakeups[0]?.();
			// Then invalid numbers cannot accidentally get ESRCH clearance.
			expect(step.dispatch()).toBe("unknown");
			expect(isDisruptiveActionPending()).toBe(true);
			expect(probes).toBe(0);
			expect(reads).toBe(0);
			expect(cleanup).toBe(0);
			expect(f.delays).toEqual([2000, 4000]);
		});
	}
}

test("unknown-tag absent identity re-reads within 700ms then clears without spinning", async () => {
	// Given no recorded identity and a catchable future tag under the audited reaping assumption.
	f = helperDispatchFixture();
	const delays: number[] = [];
	let reads = 0;
	const original = Object.assign(new Error("unknown"), {
		syscall: "future_spawn_step",
	});
	const ports = {
		euid: () => 0,
		checkLauncher: () => undefined,
		launchFile: {
			prepare: () => "/fixture/launch.pid",
			read: async () => {
				reads++;
				return null;
			},
			cleanup: () => undefined,
		},
		sleep: async (ms: number) => {
			delays.push(ms);
		},
		spawn: () => {
			throw original;
		},
		kill: () => undefined,
	};
	const step = createAddonHelperStep(["refresh"], ports);
	// When the real reservation observes no identity over the bounded schedule.
	const result = await invokeHelperAction("refresh", {
		isRealDevice: async () => true,
		exec: async () => ({ stdout: "", stderr: "" }),
		createStep: () => step,
	}).catch((error: unknown) => error);
	// Then absence settles within its explicit bound, preserving the original error.
	expect(result).toBe(original);
	expect(delays).toEqual([100, 200, 400]);
	expect(reads).toBe(4);
	expect(isDisruptiveActionPending()).toBe(false);
	expect(f.delays).toEqual([]);
});

test("cancellation during identity re-read preserves unknown and schedules zero evidence retries", async () => {
	// Given an absent first read, with shutdown racing the bounded re-read.
	f = helperDispatchFixture();
	const delays: number[] = [];
	const ports = {
		euid: () => 0,
		checkLauncher: () => undefined,
		launchFile: {
			prepare: () => "/fixture/launch.pid",
			read: async () => null,
			cleanup: () => undefined,
		},
		sleep: async (ms: number) => {
			delays.push(ms);
			cancelDisruptiveRetries();
		},
		spawn: () => {
			throw new Error("untagged");
		},
		kill: () => undefined,
	};
	const step = createAddonHelperStep(["refresh"], ports);
	// When shutdown interrupts the catch's recovery window.
	await invokeHelperAction("refresh", {
		isRealDevice: async () => true,
		exec: async () => ({ stdout: "", stderr: "" }),
		createStep: () => step,
	}).catch((error: unknown) => error);
	// Then absence cannot grant release after cancellation.
	expect(delays).toEqual([100]);
	expect(step.dispatch()).toBe("unknown");
	expect(isDisruptiveActionPending()).toBe(true);
	expect(f.delays).toEqual([]);
});
