/**
 * Every use of a unit's exit goes through its attempt's claim, taken at the
 * point of use: an exit nothing recorded, a claim an admission invalidated,
 * or a saved plan that is no longer the one that admitted the attempt never
 * reaches the tab or the orchestrator. One fixed unit name serves every
 * attempt, and CeraUI alone starts or retires it: a finished unit is retired
 * only after its outcome is claimed, and no start is admitted past it.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import {
	type SoftwareUpdateAttempt,
	softwareUpdateOutputPaths,
} from "../modules/system/software-update-output.ts";
import {
	DetachedAptServiceAlreadyExistsError,
	DetachedAptServiceUnrecordedError,
	type DetachedAptUpgradeDeps,
	RECORDED_OUTCOME_REPLAY_MS,
	recoverDetachedAptUpgrade,
	resetSoftwareUpdateUnitForTest,
	runDetachedAptAll,
	settleKeptSoftwareUpdateUnit,
	softwareUpdateUnitKept,
} from "../modules/system/software-update-process.ts";
import { setDetachedAptServiceDepsForTest } from "../modules/system/software-update-service.ts";
import {
	beginSoftwareUpdateRecovery,
	getLastInstallUnitVerdict,
	getPlanUpdateState,
	getUpdateState,
	recoverSoftwareUpdateIfRunning,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { defaultCommitStageProbeDeps } from "../modules/system/update-orchestrator/commit-stage-probe.ts";
import { stopPackageInstallUnitForStream } from "../modules/system/update-orchestrator/stream-abort.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();
afterEach(resetSoftwareUpdateUnitForTest);

const FIXED = "ceralive-software-update.service";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const INVOCATION_A = "a".repeat(32);
const INVOCATION_B = "b".repeat(32);
const args = buildAptAllInstallArgs(
	[{ name: "cerastream", version: "2" }],
	"any",
);
const quiet = { onStdout: () => {}, onStderr: () => {} };

type Unit = {
	kind: "running" | "finished";
	readonly invocation: string;
	readonly exitCode: number;
};

// systemd's one fixed unit and the device's record; a unit finishes on the
// next poll. Each retirement is logged with the invocation it reached.
function device(o: {
	unit?: Unit;
	readonly record: SoftwareUpdateAttempt | null;
	readonly failExitRecord?: boolean;
	failCleanup?: boolean;
	readonly onCleanup?: () => void;
	readonly transcript?: () => Promise<string | undefined>;
}) {
	let record = o.record;
	let uptime = 1_000;
	const cleanups: string[] = [];
	const started: (readonly string[])[] = [];
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: softwareUpdateOutputPaths(),
		uptimeMs: () => uptime,
		readAttempt: () => record,
		updateAttempt: (change) => {
			const next = change(record);
			if (!next) return null;
			if (o.failExitRecord && next.exitCode !== undefined)
				throw new Error("ENOSPC: /run is full");
			record = next;
			return next;
		},
		...(o.transcript ? { transcript: o.transcript } : {}),
		prepareOutput: async () => {},
		start: async (command) => {
			started.push(command);
			o.unit = { kind: "running", invocation: INVOCATION_B, exitCode: 0 };
		},
		inspect: async () => {
			const unit = o.unit;
			if (!unit) return { kind: "absent" };
			return unit.kind === "running"
				? { kind: "running", invocation: unit.invocation }
				: {
						kind: "finished",
						exitCode: unit.exitCode,
						cleanup: unit.exitCode === 0 ? "stop" : "reset-failed",
						invocation: unit.invocation,
					};
		},
		cleanup: async (state) => {
			cleanups.push(state.invocation ?? FIXED);
			o.onCleanup?.();
			if (o.failCleanup) throw new Error("systemctl stop failed");
			o.unit = undefined;
		},
		readOutput: async (_path, offset) => ({
			bytes: new Uint8Array(),
			nextOffset: offset,
		}),
		sleep: async () => {
			if (o.unit?.kind === "running") o.unit.kind = "finished";
		},
	};
	return {
		deps,
		cleanups,
		started,
		record: () => record,
		unit: () => o.unit,
		advance: (ms: number) => {
			uptime += ms;
		},
		set: (change: { failCleanup?: boolean }) => Object.assign(o, change),
	};
}

const recovery = (deps: DetachedAptUpgradeDeps) => ({
	recover: (
		handlers: Parameters<typeof recoverDetachedAptUpgrade>[0],
		_deps?: DetachedAptUpgradeDeps,
		options?: Parameters<typeof recoverDetachedAptUpgrade>[2],
	) => recoverDetachedAptUpgrade(handlers, deps, options),
	scheduleRetry: () => {},
	resumePeriodicChecks: () => {},
});

const launchedA: SoftwareUpdateAttempt = {
	schema: 2,
	attempt: A,
	phase: "launched",
	uptimeMs: 1_000,
	invocation: INVOCATION_A,
};

test("a unit's exit nothing could record is no outcome: the tab is not told it", async () => {
	await using h = await updateHarness();
	// A's own unit, running, the way every release observes it.
	const system = device({
		unit: { kind: "running", invocation: INVOCATION_A, exitCode: 0 },
		record: launchedA,
		failExitRecord: true,
	});
	// The install ends with an outcome, or with none (`updating: null`).
	const ended = Promise.withResolvers<void>();
	h.onFrame = (frame) => {
		if (frame.updating === null || frame.update_state?.kind === "success")
			ended.resolve();
	};
	beginSoftwareUpdateRecovery();
	expect(await recoverSoftwareUpdateIfRunning(recovery(system.deps))).toBe(
		true,
	);
	await ended.promise;
	expect(getUpdateState().kind).not.toBe("success");
	expect(h.frames.some((f) => f.update_state?.kind === "success")).toBe(false);
	expect(h.restarts).toBe(0);
	// Without a durable record the finished unit stays as the evidence.
	expect(system.cleanups).toEqual([]);
});

test("a finished unit's recorded exit is claimed again after its retirement: an admission meanwhile tells nothing", async () => {
	await using h = await updateHarness();
	const system = device({
		unit: { kind: "finished", invocation: INVOCATION_A, exitCode: 0 },
		record: { ...launchedA, exitCode: 0, drained: true },
		// Attempt B is admitted while A's unit is being retired.
		onCleanup: () =>
			system.deps.updateAttempt(() => ({
				schema: 2,
				attempt: B,
				phase: "accepted",
				uptimeMs: 1_000,
			})),
	});
	beginSoftwareUpdateRecovery();
	await recoverSoftwareUpdateIfRunning(recovery(system.deps));
	expect(buildInitialStatus().status.update_state?.kind).not.toBe("success");
	expect(h.frames.some((f) => f.update_state?.kind === "success")).toBe(false);
});

test("a finished unit no attempt can claim is not reported as absence, and stays", async () => {
	await using _h = await updateHarness();
	// The record names another attempt: nothing claims this unit's exit.
	const system = device({
		unit: { kind: "finished", invocation: INVOCATION_A, exitCode: 0 },
		record: { schema: 2, attempt: B, phase: "accepted", uptimeMs: 1_000 },
		failCleanup: true,
	});
	beginSoftwareUpdateRecovery();
	// Watched for display only: its exit is nobody's outcome.
	expect(await recoverSoftwareUpdateIfRunning(recovery(system.deps))).toBe(
		true,
	);
	// The unit is still there: that is not proof that nothing survived.
	expect(getLastInstallUnitVerdict()).not.toBe("absent");
	expect(getUpdateState().kind).not.toBe("success");
	expect(system.cleanups).toEqual([]);
	expect(system.unit()).toBeDefined();
	expect(softwareUpdateUnitKept()).toBe(true);
});

test("no start is accepted before boot recovery has looked at the unit", async () => {
	await using _h = await updateHarness();
	beginSoftwareUpdateRecovery();
	expect(startSoftwareUpdate()).toEqual({
		started: false,
		reason: "check_unavailable",
	});
	// Recovery finds no unit: from then on a start is accepted.
	expect(
		await recoverSoftwareUpdateIfRunning(
			recovery(device({ record: null }).deps),
		),
	).toBe(false);
	expect(startSoftwareUpdate()).toEqual({ started: true });
});

test("an attempt's success settles the orchestrator's plan only while that plan is still the saved one", async () => {
	await using h = await updateHarness();
	h.completion = Promise.resolve(0);
	startSoftwareUpdate(() => {});
	await h.check();
	expect(getPlanUpdateState().kind).toBe("success");
	// Another plan is saved now, as an older release saves its own after a rollback.
	h.plan = "f".repeat(64);
	expect(getPlanUpdateState().kind).toBe("idle");
	// The tab is still told what the device did.
	expect(getUpdateState().kind).toBe("success");
});

test("one fixed name serves every attempt: no launch starts past a finished unit, and a start settles it first, claimed then retired", async () => {
	const system = device({
		unit: { kind: "finished", invocation: INVOCATION_A, exitCode: 0 },
		record: { ...launchedA, exitCode: 0, drained: true },
		// A's unit cannot be retired for now.
		failCleanup: true,
	});
	await expect(
		runDetachedAptAll(args, "any", quiet, system.deps),
	).rejects.toBeInstanceOf(DetachedAptServiceAlreadyExistsError);
	expect(system.started).toEqual([]);
	// The start's settle claims A's outcome but cannot retire the unit: no
	// start, and A's receipt is never replaced while its unit is there.
	expect(await settleKeptSoftwareUpdateUnit(system.deps)).toBe(false);
	expect(system.record()).toMatchObject({ attempt: A, exitCode: 0 });
	expect(softwareUpdateUnitKept()).toBe(true);
	// Once it can be retired, the next start settles it and launches.
	system.set({ failCleanup: false });
	expect(await settleKeptSoftwareUpdateUnit(system.deps)).toBe(true);
	expect(system.cleanups).toEqual([INVOCATION_A, INVOCATION_A]);
	expect(await runDetachedAptAll(args, "any", quiet, system.deps)).toBe(0);
	expect(system.started).toHaveLength(1);
	expect(system.started[0]).toContain(`--unit=${FIXED}`);
	expect(system.record()?.attempt).not.toBe(A);
	// The successor's own unit was retired after its own claim.
	expect(system.cleanups).toEqual([INVOCATION_A, INVOCATION_A, INVOCATION_B]);
});

test("a recorded exit whose claim fails keeps the unit: nothing is retired and the outcome is unknown", async () => {
	// The stdout file read for the record is not the one there at the claim.
	let stats = 0;
	const system = device({
		record: null,
		transcript: async () => (++stats === 1 ? "1:10:1" : "2:10:2"),
	});
	await expect(
		runDetachedAptAll(args, "any", quiet, system.deps),
	).rejects.toBeInstanceOf(DetachedAptServiceUnrecordedError);
	expect(system.record()).toMatchObject({ exitCode: 0, transcript: "1:10:1" });
	// The unit is the only evidence left: never retired on an unconfirmed claim.
	expect(system.cleanups).toEqual([]);
	expect(system.unit()).toMatchObject({ kind: "finished" });
});

test("an older release's running unit keeps the one fixed name: the stream stop and the commit-stage probe name it, and its exit is its own invocation's", async () => {
	const system = device({
		unit: { kind: "running", invocation: INVOCATION_A, exitCode: 0 },
		record: null,
	});
	setDetachedAptServiceDepsForTest(system.deps);
	const spawn = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
		exitCode: 0,
		stdout: "",
		stderr: "",
	});
	try {
		const recovered = await recoverDetachedAptUpgrade(quiet, system.deps);
		expect(system.record()).toMatchObject({
			phase: "launched",
			invocation: INVOCATION_A,
		});
		expect(
			await stopPackageInstallUnitForStream({ commitStage: async () => false }),
		).toBe("stopped");
		await defaultCommitStageProbeDeps.showUnit();
		expect(
			spawn.mock.calls.map(([command]) => [command[1], command.at(-1)]),
		).toEqual([
			["kill", FIXED],
			["show", "--no-pager"],
		]);
		expect(spawn.mock.calls[1]?.[0][2]).toBe(FIXED);
		expect(
			recovered && "completion" in recovered ? await recovered.completion : -1,
		).toBe(0);
		expect(system.record()).toMatchObject({
			invocation: INVOCATION_A,
			exitCode: 0,
		});
		expect(system.cleanups).toEqual([INVOCATION_A]);
	} finally {
		spawn.mockRestore();
		setDetachedAptServiceDepsForTest(null);
	}
});

test("a finished unit no attempt can claim is retired only after the replay window, and the reason is logged", async () => {
	const system = device({
		unit: { kind: "finished", invocation: INVOCATION_A, exitCode: 0 },
		record: null,
	});
	await expect(
		runDetachedAptAll(args, "any", quiet, system.deps),
	).rejects.toBeInstanceOf(DetachedAptServiceAlreadyExistsError);
	expect(await settleKeptSoftwareUpdateUnit(system.deps)).toBe(false);
	system.advance(RECORDED_OUTCOME_REPLAY_MS - 1);
	expect(await settleKeptSoftwareUpdateUnit(system.deps)).toBe(false);
	expect(system.cleanups).toEqual([]);
	const warn = spyOn(logger, "warn");
	try {
		system.advance(1);
		expect(await settleKeptSoftwareUpdateUnit(system.deps)).toBe(true);
		expect(system.cleanups).toEqual([INVOCATION_A]);
		expect(warn).toHaveBeenCalledWith(
			"Software update: abandoning a finished update unit whose outcome was never confirmed",
			expect.objectContaining({
				invocation: INVOCATION_A,
				reason: "no readable attempt record",
			}),
		);
	} finally {
		warn.mockRestore();
	}
	expect(softwareUpdateUnitKept()).toBe(false);
});
