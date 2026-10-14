import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	addonDisable,
	addonEnable,
	addonRefresh,
} from "../helpers/addon-helper.ts";
import { createAddonHelperStep } from "../helpers/addon-helper-step.ts";
import { helperGroupRetirement } from "../helpers/helper-group-retirement.ts";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { cancelDisruptiveRetries } from "../modules/system/disruptive-retry.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { helperLaunchFixture } from "./helpers/helper-launch-fixture.ts";
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
const errno = (code: string) =>
	Object.assign(new Error("signal zero"), { code });

for (const action of ["enable", "disable", "refresh"] as const) {
	for (const code of [0, 1, 137, 143]) {
		test(`${action} exit ${code} probes its negative group once then retains queued descriptor jobs`, async () => {
			// Given retired descendants but a submitted descriptor job, and unrelated census denial.
			let job = 9;
			const targets: number[] = [];
			const units: string[] = [];
			f.rows["1"] = errno("EACCES");
			const original = Object.assign(new Error("original"), { code });
			const step = helperStepFixture(
				async () => {
					if (code) throw original;
					return { stdout: "ok", stderr: "" };
				},
				(pid, signal) => {
					targets.push(pid);
					expect(signal).toBe(0);
					throw errno("ESRCH");
				},
			);
			const unitProbe = spyOn(
				spawnPolicy,
				"spawnWithTimeout",
			).mockImplementation(async (argv) => {
				units.push(argv[argv.length - 1] ?? "");
				return {
					exitCode: 0,
					stderr: "",
					stdout: `Job=${job}\nActiveState=inactive\nSubState=dead\n`,
				};
			});
			const deps = {
				isRealDevice: async () => true,
				readDescriptor: async () => sysextDescriptor,
				exec: async () => ({ stdout: "", stderr: "" }),
				createStep: () => step,
			};
			try {
				// When the wrapper handles the original result and bounded evidence wakeups.
				const result = await (action === "enable"
					? addonEnable("cog-display", deps)
					: action === "disable"
						? addonDisable("cog-display", deps)
						: addonRefresh(deps)
				).catch((error: unknown) => error);
				expect(result).toBe(code ? original : "ok");
				expect(targets).toEqual([-42]);
				if (action !== "refresh") {
					expect(isDisruptiveActionPending()).toBe(true);
					expect(units).toEqual(["kiosk.service"]);
					await f.wake();
					expect(isDisruptiveActionPending()).toBe(true);
					expect(targets).toEqual([-42]);
					job = 0;
					await f.wake();
					expect(units).toEqual([
						"kiosk.service",
						"kiosk.service",
						"kiosk.service",
					]);
				} else expect(units).toEqual([]);
				// Then unrelated proc denial cannot obstruct contained completion or cause a reused-group probe.
				expect(isDisruptiveActionPending()).toBe(false);
				expect(targets).toEqual([-42]);
			} finally {
				unitProbe.mockRestore();
			}
		});
	}
}

for (const code of ["EPERM", "EINVAL", "EIO", "ENOENT", "unexpected"]) {
	test(`${code} is UNKNOWN through the real refresh resolver until literal ESRCH`, async () => {
		// Given a positively exited child with an unproven group observation.
		let answer = code;
		const targets: number[] = [];
		const step = helperStepFixture(
			async () => ({ stdout: "ok", stderr: "" }),
			(pid) => {
				targets.push(pid);
				throw errno(answer);
			},
		);
		// When success still passes through mandatory retirement and then evidence repairs.
		await addonRefresh({
			isRealDevice: async () => true,
			exec: async () => ({ stdout: "", stderr: "" }),
			createStep: () => step,
		});
		expect(isDisruptiveActionPending()).toBe(true);
		expect(getDisruptiveActionDecision()).toEqual({
			allowed: false,
			reason: "update_in_progress",
		});
		answer = "ESRCH";
		await f.wake();
		// Then only ESRCH retires the group, with a negative target every time.
		expect(isDisruptiveActionPending()).toBe(false);
		expect(targets).toEqual([-42, -42]);
	});
}

for (const pgid of [0, -1, 1, 2.5, NaN, Infinity]) {
	test(`invalid owned PGID ${pgid} never probes or retires`, async () => {
		const targets: number[] = [];
		const probe = helperGroupRetirement(
			() => ({ pgid, exitCode: 0 }),
			(pid) => {
				targets.push(pid);
				throw errno("ESRCH");
			},
		);
		const step = {
			...helperStepFixture(async () => ({ stdout: "ok", stderr: "" })),
			probe,
		};
		await addonRefresh({
			isRealDevice: async () => true,
			exec: async () => ({ stdout: "", stderr: "" }),
			createStep: () => step,
		});
		await f.wake();
		expect(isDisruptiveActionPending()).toBe(true);
		expect(targets).toEqual([]);
	});
}

test("actual child exit is required before the group syscall", async () => {
	let exitCode: number | undefined;
	const targets: number[] = [];
	const probe = helperGroupRetirement(
		() => ({ pgid: 42, exitCode }),
		(pid) => {
			targets.push(pid);
			throw errno("ESRCH");
		},
	);
	const step = {
		...helperStepFixture(async () => ({ stdout: "ok", stderr: "" })),
		probe,
	};
	await addonRefresh({
		isRealDevice: async () => true,
		exec: async () => ({ stdout: "", stderr: "" }),
		createStep: () => step,
	});
	expect(isDisruptiveActionPending()).toBe(true);
	expect(targets).toEqual([]);
	exitCode = 0;
	await f.wake();
	expect(isDisruptiveActionPending()).toBe(false);
	expect(targets).toEqual([-42]);
});

test("a zombie retains the group until reaped without a time or census exemption", async () => {
	let reaped = false;
	let probes = 0;
	const step = helperStepFixture(
		async () => ({ stdout: "ok", stderr: "" }),
		() => {
			probes++;
			if (reaped) throw errno("ESRCH");
			return true;
		},
	);
	await addonRefresh({
		isRealDevice: async () => true,
		exec: async () => ({ stdout: "", stderr: "" }),
		createStep: () => step,
	});
	for (let n = 0; n < 8; n++) {
		await f.wake();
		expect(isDisruptiveActionPending()).toBe(true);
	}
	expect(probes).toBe(9);
	reaped = true;
	await f.wake();
	expect(isDisruptiveActionPending()).toBe(false);
	expect(probes).toBe(10);
});

for (const euid of [1000, 0]) {
	test(`pre-effect ${euid ? "non-root" : "missing setsid"} refusal releases with zero group probes`, async () => {
		let spawns = 0;
		let probes = 0;
		const step = createAddonHelperStep(["refresh"], {
			launchFile: helperLaunchFixture(),
			euid: () => euid,
			checkLauncher: () => {
				throw errno("ENOENT");
			},
			spawn: () => {
				spawns++;
				throw new Error("must not spawn");
			},
			kill: () => {
				probes++;
			},
		});
		const result = await addonRefresh({
			isRealDevice: async () => true,
			exec: async () => ({ stdout: "", stderr: "" }),
			createStep: () => step,
		}).catch((error: unknown) => error);
		expect(result).toMatchObject({ code: euid ? "EACCES" : "ENOENT" });
		expect(step.spawned()).toBe(false);
		expect(spawns).toBe(0);
		expect(probes).toBe(0);
		expect(isDisruptiveActionPending()).toBe(false);
	});
}

test("cancelled evidence callbacks perform zero late probes or reschedules and preserve the hold", async () => {
	let probes = 0;
	const step = helperStepFixture(
		async () => ({ stdout: "ok", stderr: "" }),
		() => {
			probes++;
		},
	);
	await addonRefresh({
		isRealDevice: async () => true,
		exec: async () => ({ stdout: "", stderr: "" }),
		createStep: () => step,
	});
	const late = f.wakeups.shift();
	if (!late) throw new Error("missing callback");
	cancelDisruptiveRetries();
	await late();
	await evidenceJobs();
	expect(probes).toBe(1);
	expect(f.wakeups).toEqual([]);
	expect(isDisruptiveActionPending()).toBe(true);
});
