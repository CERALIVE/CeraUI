import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import {
	addonDisable,
	addonEnable,
	addonRefresh,
} from "../helpers/addon-helper.ts";
import { ADDON_HELPER_ENV } from "../helpers/addon-helper-step.ts";
import { SpawnTimeoutError } from "../helpers/bounded-spawn.ts";
import { ADDON_HELPER_LAUNCHER } from "../helpers/helper-launch-file.ts";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { groupProcessFixture } from "./helpers/group-process-fixture.ts";
import { completionFixture } from "./helpers/sysext-completion-fixture.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof completionFixture>;
let restoreUnits: () => void;
beforeEach(() => {
	f = completionFixture();
	const probe = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
		exitCode: 0,
		stdout: "Job=0\nActiveState=inactive\nSubState=dead\n",
		stderr: "",
	});
	restoreUnits = () => probe.mockRestore();
});
afterEach(() => {
	restoreUnits();
	f.reset();
});
const signal = () => new AbortController().signal;

for (const action of ["enable", "disable"] as const) {
	for (const mode of ["term", "kill"] as const) {
		test(`${action} collector ${mode} preserves ${mode === "term" ? 143 : 137}, partial streams and the surviving group`, async () => {
			// Given an exclusively owned real child and orphan, and no host lifecycle tools.
			const p = await groupProcessFixture(mode);
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
			void p.watch(
				work,
				`${action} collector ${mode} preserves ${mode === "term" ? 143 : 137}, partial streams and the surviving group`,
			);
			try {
				const worker = await p.worker();
				const leader: unknown = JSON.parse(await p.wait("leader"));
				expect(leader).toEqual({
					pid: p.step.child()?.pid,
					pgid: p.step.child()?.pid,
					sid: p.step.child()?.pid,
				});
				expect(worker).toMatchObject({
					pgid: p.step.child()?.pid,
					sid: p.step.child()?.pid,
				});
				// When the controlled command deadline drives the real collector's child-only termination.
				p.fire(30000);
				if (mode === "kill") {
					await p.fireWhenScheduled(100);
				}
				const result = await work;
				// Then signal evidence and partial output survive; a descendant is not retired by its parent.
				expect(result).toBeInstanceOf(SpawnTimeoutError);
				expect(result).toMatchObject({
					code: mode === "term" ? 143 : 137,
					stdout: "partial-out\n",
					stderr: "partial-err\n",
				});
				expect(p.step.exitCode()).toBe(mode === "term" ? 143 : 137);
				expect(isDisruptiveActionPending()).toBe(true);
				expect(await p.step.probe(signal())).toBe("in-flight");
			} finally {
				await p.cleanup();
			}
		}, 15000);
	}
}

test("TERM-induced zero stays a timeout failure and passes mandatory evidence", async () => {
	const p = await groupProcessFixture("zero-term");
	const work = addonRefresh({
		isRealDevice: async () => true,
		exec: () => p.step.run(),
		createStep: () => p.step,
	}).catch((error: unknown) => error);
	void p.watch(
		work,
		"TERM-induced zero stays a timeout failure and passes mandatory evidence",
	);
	try {
		await p.wait("leader");
		p.fire(30000);
		const result = await work;
		expect(result).toBeInstanceOf(SpawnTimeoutError);
		expect(result).toMatchObject({
			code: 0,
			stdout: "partial-out\n",
			stderr: "partial-err\n",
		});
		expect(p.step.exitCode()).toBe(0);
		expect(isDisruptiveActionPending()).toBe(false);
	} finally {
		await p.cleanup();
	}
}, 15000);

test("TERM queued before the fixture waits still yields zero timeout evidence", async () => {
	// Given a child held before its synchronous TERM wait, with TERM already blocked.
	const p = await groupProcessFixture("zero-term-pending");
	const work = addonRefresh({
		isRealDevice: async () => true,
		exec: () => p.step.run(),
		createStep: () => p.step,
	}).catch((error: unknown) => error);
	try {
		await p.wait("leader");
		const child = p.step.child();
		if (child === undefined) throw new Error("missing ready child");
		// When the real collector sends TERM before the fixture can enter sigwait.
		p.fire(30000);
		const pendingMasks = /^(?:SigPnd|ShdPnd):\s+([\da-f]+)$/gm;
		for (;;) {
			const status = await readFile(`/proc/${child.pid}/status`, "utf8");
			if (
				[...status.matchAll(pendingMasks)].some(([, mask]) => {
					if (mask === undefined) throw new Error("missing signal mask");
					return (BigInt(`0x${mask}`) & 0x4000n) !== 0n;
				})
			)
				break;
			await setImmediate();
		}
		expect(p.step.exitCode()).toBeUndefined();
		await p.release();
		const result = await work;
		// Then pending TERM is consumed without a second signal or collector-clock advance.
		expect(result).toBeInstanceOf(SpawnTimeoutError);
		expect(result).toMatchObject({
			code: 0,
			stdout: "partial-out\n",
			stderr: "partial-err\n",
		});
		expect(p.step.exitCode()).toBe(0);
		expect(isDisruptiveActionPending()).toBe(false);
	} finally {
		await p.cleanup();
	}
}, 15000);

for (const mode of ["survivor", "double", "escape"] as const) {
	for (const code of [0, 1]) {
		test(`real ${mode} descendant after helper exit ${code} pins the group boundary and its session-escape limit`, async () => {
			const p = await groupProcessFixture(mode, code);
			const work = addonRefresh({
				isRealDevice: async () => true,
				exec: () => p.step.run(),
				createStep: () => p.step,
			}).catch((error: unknown) => error);
			void p.watch(
				work,
				`real ${mode} descendant after helper exit ${code} pins the group boundary and its session-escape limit`,
			);
			try {
				const worker = await p.worker();
				const result = await work;
				if (code) expect(result).toMatchObject({ code: 1 });
				else expect(result).toBe("partial-out\n");
				expect(p.step.exitCode()).toBe(code);
				if (mode === "escape") {
					expect(worker).not.toMatchObject({ pgid: p.step.child()?.pid });
					expect(await p.step.probe(signal())).toBe("completed");
					expect(isDisruptiveActionPending()).toBe(false);
				} else {
					expect(worker).toMatchObject({ pgid: p.step.child()?.pid });
					expect(isDisruptiveActionPending()).toBe(true);
					await p.release();
					const watchdog = setTimeout(() => {
						throw new Error("orphan not reaped");
					}, 10000);
					try {
						while ((await p.step.probe(signal())) !== "completed")
							await setImmediate();
					} finally {
						clearTimeout(watchdog);
					}
					p.workerRetired();
					await f.wake();
					expect(isDisruptiveActionPending()).toBe(false);
				}
			} finally {
				await p.cleanup();
			}
		}, 15000);
	}
}

test("ordinary checked launcher preserves PID=PGID=SID and fixed environment without detached or sudo", async () => {
	const p = await groupProcessFixture("plain");
	try {
		const work = p.step.run();
		void p.watch(
			work,
			"ordinary checked launcher preserves PID=PGID=SID and fixed environment without detached or sudo",
		);
		const leader: unknown = JSON.parse(await p.wait("leader"));
		expect(leader).toEqual({
			pid: p.step.child()?.pid,
			pgid: p.step.child()?.pid,
			sid: p.step.child()?.pid,
		});
		expect(await work).toEqual({
			stdout: "partial-out\n",
			stderr: "partial-err\n",
		});
		expect(p.launches).toEqual([
			{
				argv: [
					"/usr/bin/setsid",
					"-w",
					"--",
					"/usr/bin/bash",
					"-c",
					ADDON_HELPER_LAUNCHER,
					"ceralive-addon-launch",
					expect.stringMatching(/\/helper-group-[^/]+\/[a-f0-9-]+\.pid$/),
					"/usr/bin/ceralive-addon-helper",
					"refresh",
				],
				options: {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: {
						PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
						LANG: "C",
						LC_ALL: "C",
					},
				},
			},
		]);
		expect(ADDON_HELPER_ENV).toEqual({
			PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
			LANG: "C",
			LC_ALL: "C",
		});
	} finally {
		await p.cleanup();
	}
}, 15000);
