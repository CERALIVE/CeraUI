import { afterEach, beforeEach, expect, test } from "bun:test";
import { addonRefresh } from "../helpers/addon-helper.ts";
import { createAddonHelperStep } from "../helpers/addon-helper-step.ts";
import { SpawnAbortError } from "../helpers/bounded-spawn.ts";
import { runDisruptiveSysextStep } from "../modules/addons/disruptive-sysext-step.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	helperDispatchFixture,
	invokeHelperAction,
	launchErrno,
} from "./helpers/helper-dispatch-fixture.ts";
import { helperLaunchFixture } from "./helpers/helper-launch-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof helperDispatchFixture>;
beforeEach(() => {
	f = helperDispatchFixture();
});
afterEach(() => f.reset());
const exec = async () => ({ stdout: "", stderr: "" });

test("a child handle exists when collector rejects EIO, so the helper stays held", async () => {
	// Given a real returned child whose collector throws the same errno as prelaunch.
	const original = launchErrno("EIO");
	const step = createAddonHelperStep(["refresh"], {
		launchFile: helperLaunchFixture(),
		euid: () => 0,
		checkLauncher: () => undefined,
		spawn: (_argv, options) => Bun.spawn(["/usr/bin/true"], options),
		kill: () => true,
		collect: {
			onSpawn: () => {
				throw original;
			},
			scheduleTimeout: () => 1,
			cancelTimeout: () => undefined,
		},
	});
	// When the real collector fails after dispatch.
	const result = await addonRefresh({
		isRealDevice: async () => true,
		exec,
		createStep: () => step,
	}).catch((error: unknown) => error);
	// Then error preservation must not become a release for effectful failures.
	expect(result).toBe(original);
	expect(step.spawned()).toBe(true);
	expect(step.dispatch()).toBe("started");
	expect(isDisruptiveActionPending()).toBe(true);
	expect(f.delays).toEqual([2000]);
	expect(getDisruptiveActionDecision()).toEqual({
		allowed: false,
		reason: "update_in_progress",
	});
});

test("unknown dispatch cannot release on an ordinary classifier errno", async () => {
	// Given allocated but never executed evidence and an unrelated rejected effect.
	const original = launchErrno("EACCES");
	const step = createAddonHelperStep(["refresh"]);
	expect(step.dispatch()).toBe("unknown");
	// When the seam cannot prove which effect executed.
	const result = await runDisruptiveSysextStep(
		"unknown",
		async () => {
			throw original;
		},
		{ units: [], helper: step },
	).catch((error: unknown) => error);
	// Then missing ownership is unknown, not typed positive no-dispatch.
	expect(result).toBe(original);
	expect(isDisruptiveActionPending()).toBe(true);
	expect(f.delays).toEqual([2000]);
});

for (const moment of [
	"inside returning spawn",
	"after handle assignment",
] as const) {
	test(`abort ${moment} keeps dispatched work behind group evidence`, async () => {
		// Given a real pipe-producing child with its exit controlled by collector termination.
		const abort = new AbortController();
		const step = createAddonHelperStep(["refresh"], {
			launchFile: helperLaunchFixture(),
			euid: () => 0,
			checkLauncher: () => undefined,
			spawn: (_argv, options) => {
				const child = Bun.spawn(["/usr/bin/sleep", "30"], options);
				if (moment === "inside returning spawn") abort.abort();
				return child;
			},
			kill: () => true,
			collect: {
				signal: abort.signal,
				onSpawn: () => {
					if (moment === "after handle assignment") abort.abort();
				},
				scheduleTimeout: () => 1,
				cancelTimeout: () => undefined,
			},
		});
		// When abort races the synchronous return/assignment or follows assignment.
		const result = await addonRefresh({
			isRealDevice: async () => true,
			exec,
			createStep: () => step,
		}).catch((error: unknown) => error);
		// Then a returned child is always started; no aborted error grants clearance.
		expect(result).toBeInstanceOf(SpawnAbortError);
		expect(step.spawned()).toBe(true);
		expect(isDisruptiveActionPending()).toBe(true);
		expect(f.delays).toEqual([2000]);
	});
}

for (const action of ["enable", "disable"] as const) {
	for (const code of ["EIO", "EACCES", "ENOENT"] as const) {
		test(`${action} descriptor ${code} fails before ticket acquisition or runner allocation`, async () => {
			// Given descriptor authority unavailable before the admitted runner exists.
			const original = launchErrno(code);
			let allocated = 0;
			// When the actual wrapper cannot read its descriptor.
			const result = await invokeHelperAction(action, {
				isRealDevice: async () => true,
				exec,
				readDescriptor: async () => {
					throw original;
				},
				createStep: (args) => {
					allocated++;
					return createAddonHelperStep(args);
				},
			}).catch((error: unknown) => error);
			// Then no ticket, launch, retirement probe or retry exists.
			expect(result).toBe(original);
			expect(allocated).toBe(0);
			expect(isDisruptiveActionPending()).toBe(false);
			expect(f.units).toEqual([]);
			expect(f.delays).toEqual([]);
		});
	}
}
