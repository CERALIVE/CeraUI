import { afterEach, beforeEach, expect, test } from "bun:test";
import { addonRefresh } from "../helpers/addon-helper.ts";
import {
	AddonHelperLaunchError,
	createAddonHelperStep,
} from "../helpers/addon-helper-step.ts";
import { SpawnAbortError } from "../helpers/bounded-spawn.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	helperDispatchFixture,
	invokeHelperAction,
	launchErrno,
} from "./helpers/helper-dispatch-fixture.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof helperDispatchFixture>;
beforeEach(() => {
	f = helperDispatchFixture();
});
afterEach(() => f.reset());
const exec = async () => ({ stdout: "", stderr: "" });

for (const action of ["enable", "disable", "refresh"] as const) {
	for (const fault of [
		"launcher EIO",
		"launcher EACCES",
		"missing launcher",
		"non-root",
		"abort before spawn",
		"env construction",
		...[
			"EMFILE",
			"ENFILE",
			"EAGAIN",
			"ENOMEM",
			"EIO",
			"EACCES",
			"ENOENT",
			"ENOEXEC",
			"E2BIG",
		].map((code) => `spawn ${code}`),
	]) {
		test(`${action} ${fault} releases zero-dispatch evidence without probes or wakeups and admits repaired refresh`, async () => {
			// Given a pre-effect failure at the real runner, not an exit-code fake.
			const original =
				fault === "non-root"
					? new AddonHelperLaunchError()
					: launchErrno(
							fault === "missing launcher"
								? "ENOENT"
								: fault === "env construction"
									? "EIO"
									: (fault.split(" ")[1] ?? "ENOENT"),
						);
			const abort = new AbortController();
			if (fault === "abort before spawn") abort.abort();
			let attempts = 0,
				signals = 0;
			const step = createAddonHelperStep(
				action === "refresh" ? [action] : [action, "cog-display"],
				{
					euid: () => (fault === "non-root" ? 1000 : 0),
					checkLauncher: () => {
						if (fault.startsWith("launcher") || fault === "missing launcher")
							throw original;
					},
					spawn: () => {
						attempts++;
						throw original;
					},
					kill: () => {
						signals++;
					},
					get collect() {
						if (fault === "env construction") throw original;
						return { signal: abort.signal };
					},
				},
			);
			// When admission reaches the actual helper wrapper and fails before dispatch.
			const result = await invokeHelperAction(action, {
				isRealDevice: async () => true,
				exec,
				readDescriptor: async () => sysextDescriptor,
				createStep: () => step,
			}).catch((error: unknown) => error);
			// Then failure identity/taxonomy survives, but there is no external work to retire.
			if (fault === "non-root")
				expect(result).toBeInstanceOf(AddonHelperLaunchError);
			else if (fault === "abort before spawn")
				expect(result).toBeInstanceOf(SpawnAbortError);
			else expect(result).toBe(original);
			expect(step.spawned()).toBe(false);
			expect(step.dispatch()).toBe("none");
			expect(attempts).toBe(fault.startsWith("spawn") ? 1 : 0);
			expect(signals).toBe(0);
			expect(f.units).toEqual([]);
			expect(f.wakeups).toEqual([]);
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
			expect(repaired.spawned()).toBe(true);
			expect(isDisruptiveActionPending()).toBe(false);
		});
	}
}

test("real EMFILE in a private lowered-limit subprocess releases helper tickets after descriptors close", async () => {
	// Given a private process, never the test runner's descriptor table.
	const child = Bun.spawn(
		[
			"/usr/bin/prlimit",
			"--nofile=128:128",
			"--",
			process.execPath,
			"test",
			new URL("./helpers/helper-emfile-child.ts", import.meta.url).pathname,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const watchdog = setTimeout(() => child.kill("SIGKILL"), 30000);
	try {
		const stdout = new Response(child.stdout).text(),
			stderr = new Response(child.stderr).text();
		// When genuine Bun.spawn cannot allocate its pipes, then all disposable fds close.
		const rc = await child.exited;
		const output = (await stdout) + (await stderr);
		// Then each action's actual wrapper must preserve EMFILE and leave no hold.
		expect(output).toContain("REAL_EMFILE enable");
		expect(output).toContain("REAL_EMFILE disable");
		expect(output).toContain("REAL_EMFILE refresh");
		expect(rc).toBe(0);
	} finally {
		clearTimeout(watchdog);
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		await child.exited;
	}
}, 45000);
