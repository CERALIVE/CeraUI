import { expect, test } from "bun:test";
import {
	equalSets,
	lockKey,
	lockTable,
	parentOf,
	splitArgv,
} from "../modules/system/update-orchestrator/os-stage-guard-kernel-rows.ts";
import { proveOsGuardKernelOwnership } from "../modules/system/update-orchestrator/os-stage-guard-lock.ts";
import {
	isOsStageGuardJobIdle,
	observeOsStageGuard,
	parseOsStageGuardObservation,
} from "../modules/system/update-orchestrator/os-stage-guard-observation.ts";
import { retireReleasedOsStageGuard } from "../modules/system/update-orchestrator/os-stage-guard-retirement.ts";
import { realDeviceReply } from "./helpers/real-device-fixture.ts";
import {
	guardian2Kernel,
	guardian2KilledToken,
	guardian2Lock,
	guardian2ProductIdentity,
	guardian2Section,
	guardian2Token,
} from "./helpers/real-guardian2.ts";

test.each([
	["running", guardian2Token, { kind: "live", pid: "1640654" }],
	["ack-0000", guardian2Token, { kind: "live", pid: "1640654" }],
	[
		"exited",
		guardian2Token,
		{ kind: "terminal", cleanExit: true, exitStatus: 0 },
	],
	[
		"failed",
		guardian2KilledToken,
		{ kind: "terminal", cleanExit: false, exitStatus: 9 },
	],
	["stop-absent", guardian2Token, { kind: "absent" }],
	["reset-absent", guardian2KilledToken, { kind: "absent" }],
] as const)(
	"observes the real %s lifecycle when the exact combined request is replayed",
	async (stage, token, expected) => {
		// Given one complete captured combined request, with isolated identity aliases.
		const reply = await realDeviceReply(
			"rock-guardian2",
			`${stage}-observation`,
		);
		// When the production observer reads that command reply.
		const result = await observeOsStageGuard(
			async () => ({
				...reply,
				stdout: guardian2ProductIdentity(reply.stdout),
			}),
			token,
		);
		// Then real lifecycle grammar determines the verdict.
		expect(result).toMatchObject(expected);
	},
);

test("proves the captured helper and sleep inherited fds when the real tree holds the lock", async () => {
	// Given each member's own cmdline, stat, cgroup, fd stat and fdinfo receipts.
	const deps = await guardian2Kernel("running");
	// When the production kernel witness runs over those captured members.
	const result = await proveOsGuardKernelOwnership(
		{ pid: "1640654", attemptId: guardian2Token },
		deps,
	);
	// Then the tree's granted row and whole-table row prove one lock.
	expect(result).toBe(true);
});

test("correlates fdinfo ordinals with the whole lock table when inherited rows share one grant", async () => {
	// Given independently captured rows from all three members.
	const lock = await guardian2Lock();
	const grant = lockTable(await guardian2Section("locks"), lock);
	const rows = await Promise.all(
		["1640654", "1640666", "1640675"].map(async (pid) => {
			const info = await guardian2Section(`running-${pid}-fdinfo-3`);
			const row = info.split("\n").find((line) => line.startsWith("lock:"));
			if (!row) throw new Error("Missing captured granted row");
			return lockKey(row.slice(5), lock);
		}),
	);
	// When the production row parser removes only each file's ordinal.
	const granted = new Set(rows.map((row) => row?.value ?? ""));
	// Then every descendant reports the same single kernel grant.
	expect(grant !== null && equalSets(grant, granted)).toBe(true);
});

test("reads real NUL argv and parentage when the sleep child belongs to the helper", async () => {
	// Given the captured sleep cmdline and proc stat.
	const cmdline = Buffer.from(
		(await guardian2Section("running-1640675-cmdline")).trim(),
		"base64",
	).toString();
	const stat = await guardian2Section("running-1640675-stat");
	// When production process-row readers decode the capture.
	const actual = { argv: splitArgv(cmdline), parent: parentOf(stat) };
	// Then the child really is the helper's sleep, not an invented descendant.
	expect(actual).toEqual({ argv: ["sleep", "1"], parent: "1640666" });
});

test("accepts the typed zero job when the real helper is live", async () => {
	// Given the real typed D-Bus property reply.
	const reply = await realDeviceReply("rock-guardian2", "job");
	// When production parses Unit.Job.
	const idle = await isOsStageGuardJobIdle(async () => reply);
	// Then no systemd transition job is in flight.
	expect(idle).toBe(true);
});

test("waits through real ack-pending before stopping when normal helper exit is observed", async () => {
	// Given a real live-with-release reply followed by normal exit and stop absence.
	const stages = ["ack-0000", "exited", "stop-absent"];
	let index = 0;
	let clock = 0;
	const actions: string[] = [];
	const retired = await guardian2Kernel("exited");
	// When production retirement sees the captured lifecycle sequence.
	await retireReleasedOsStageGuard({
		attemptId: guardian2Token,
		inspect: async () =>
			parseOsStageGuardObservation(
				guardian2ProductIdentity(
					await guardian2Section(
						`${stages[index] ?? "stop-absent"}-observation`,
					),
				),
				guardian2Token,
			),
		kernel: async (input) => proveOsGuardKernelOwnership(input, retired),
		jobIdle: async () =>
			isOsStageGuardJobIdle(async () =>
				realDeviceReply("rock-guardian2", "exited-job"),
			),
		run: async (argv) => {
			actions.push(argv.slice(0, 2).join(" "));
			index = 2;
			return realDeviceReply("rock-guardian2", "stop");
		},
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
			index = 1;
		},
	});
	// Then ack-pending was waited out and only the normally exited owned unit stopped.
	expect(actions).toEqual(["systemctl stop"]);
});
