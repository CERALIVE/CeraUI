import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	probeSysextActors,
	runDisruptiveSysextStep,
} from "../modules/addons/disruptive-sysext-step.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	absentPid,
	completionFixture,
	evidenceJobs,
} from "./helpers/sysext-completion-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof completionFixture>;
beforeEach(() => {
	f = completionFixture();
});
afterEach(() => f.reset());

test("a vanished parent handing off to an unseen worker retains the production reservation", async () => {
	// Given PID 42 forks a sysext worker and vanishes after the initial listing.
	f.state.read = (pid) => {
		if (pid !== "42") return;
		f.rows["42"] = absentPid();
		f.rows["43"] = "/usr/bin/systemd-sysext\0refresh\0";
		f.executables["43"] = "/usr/bin/systemd-sysext";
		f.state.entries = ["1", "43"];
	};
	// When the real seam reports an uncertain client outcome.
	await runDisruptiveSysextStep("handoff", async () => {
		throw new Error("uncertain");
	}).catch(() => undefined);
	await evidenceJobs();
	// Then handoff is not retirement; only a later clean census releases.
	expect(isDisruptiveActionPending()).toBe(true);
	expect(getDisruptiveActionDecision()).toEqual({
		allowed: false,
		reason: "update_in_progress",
	});
	expect(f.wakeups).toHaveLength(1);
	f.state.entries = ["1"];
	await f.wake();
	expect(isDisruptiveActionPending()).toBe(false);
});

test("a newly listed worker is read even when no captured parent vanishes", async () => {
	// Given a new sysext PID appears during a readable non-actor pass.
	f.state.list = () => {
		if (f.state.lists < 2) return;
		f.rows["43"] = "(sd-merge)\0";
		f.executables["43"] = "/usr/bin/systemd-sysext";
		f.state.entries = ["1", "42", "43"];
	};
	// When the production observer checks completion.
	const answer = await probeSysextActors(
		undefined,
		new AbortController().signal,
	);
	// Then no unread new PID may be called completed.
	expect(answer).toBe("in-flight");
});

for (const argv of ["(sd-merge)\0", "(sd-unmerge)\0", "unrelated\0"] as const) {
	test(`kernel sysext identity retains exclusion despite argv ${JSON.stringify(argv)}`, async () => {
		// Given a normally renamed binary worker, including an upgraded deleted inode.
		f.rows["42"] = argv;
		f.executables["42"] = "/usr/bin/systemd-sysext (deleted)";
		// When the actual seam and resolver receive an uncertain result.
		await runDisruptiveSysextStep("renamed", async () => {
			throw new Error("uncertain");
		}).catch(() => undefined);
		await evidenceJobs();
		// Then mutable argv cannot open admission; readable retirement can.
		expect(isDisruptiveActionPending()).toBe(true);
		f.rows["42"] = "/usr/bin/bun\0";
		f.executables["42"] = "/usr/bin/bun";
		await f.wake();
		expect(isDisruptiveActionPending()).toBe(false);
	});
}

for (const code of ["EACCES", "EIO"] as const) {
	test(`unreadable executable ${code} stays UNKNOWN until evidence repairs`, async () => {
		// Given readable misleading argv but a kernel identity we cannot read.
		f.executables["42"] = Object.assign(new Error("exe denied"), { code });
		// When an uncertain helper settles through the production reservation.
		await runDisruptiveSysextStep("permission", async () => {
			throw new Error("uncertain");
		}).catch(() => undefined);
		await evidenceJobs();
		// Then repeated denial never clears; a later readable unrelated exe does.
		expect(isDisruptiveActionPending()).toBe(true);
		await f.wake();
		expect(isDisruptiveActionPending()).toBe(true);
		f.executables["42"] = "/usr/bin/bun";
		await f.wake();
		expect(isDisruptiveActionPending()).toBe(false);
	});
}

test("unrelated short-lived churn settles in a bounded consistent pass", async () => {
	// Given an unread vanished row, then a readable short-lived unrelated successor.
	f.state.read = (pid) => {
		if (pid === "42") {
			f.rows["42"] = absentPid();
			f.rows["43"] = "/usr/bin/true\0";
			f.executables["43"] = "/usr/bin/true";
			f.state.entries = ["1", "43"];
		} else if (pid === "43") f.state.entries = ["1"];
	};
	// When completion is observed without a real timer or host procfs.
	const answer = await probeSysextActors(
		undefined,
		new AbortController().signal,
	);
	// Then unrelated disappearance after identification does not livelock.
	expect(answer).toBe("completed");
	expect(f.state.lists).toBeGreaterThanOrEqual(3);
	expect(f.state.lists).toBeLessThanOrEqual(8);
});

test("continuous unread churn exhausts bounded passes without clearing exclusion", async () => {
	// Given every listed non-init PID vanishes before identity can be read.
	f.state.read = (pid) => {
		if (pid === "1") return;
		f.rows[pid] = absentPid();
		f.state.entries = ["1", String(Number(pid) + 1)];
	};
	// When the actual observer spends its immediate census budget.
	const answer = await probeSysextActors(
		undefined,
		new AbortController().signal,
	);
	// Then uncertainty is bounded work, not completion or an infinite synchronous loop.
	expect(answer).toBe("unknown");
	expect(f.state.lists).toBeLessThanOrEqual(8);
});

for (const [state, flags] of [
	["Z", "0"],
	["S", "2097152"],
] as const) {
	test(`empty ${state}/${flags} non-executable row does not wedge healthy completion`, async () => {
		// Given kernel-backed zombie/kernel-thread stat and no executable link.
		f.rows["42"] = "";
		f.executables["42"] = absentPid();
		f.stats["42"] = `42 (kernel worker) ${state} 1 0 0 0 0 ${flags} 0`;
		// When the production observer sees an otherwise healthy table.
		const answer = await probeSysextActors(
			undefined,
			new AbortController().signal,
		);
		// Then only explicit non-executable evidence permits this healthy case.
		expect(answer).toBe("completed");
	});
}

test("empty live userspace argv with no executable is UNKNOWN, not an idle row", async () => {
	// Given a live non-kernel task lacking executable proof.
	f.rows["42"] = "";
	f.executables["42"] = absentPid();
	f.stats["42"] = "42 (worker) S 1 0 0 0 0 0 0";
	// When its table is observed.
	const answer = await probeSysextActors(
		undefined,
		new AbortController().signal,
	);
	// Then empty is not absence.
	expect(answer).toBe("unknown");
});
