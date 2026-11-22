/**
 * The update unit has one starter and one owner of its lifecycle: every stop
 * of it (Go Live's included) runs under the same lock as starts, recovery and
 * retirement; the outcome claimed before a retirement is the outcome after it;
 * only a probe that found no unit is absence; and an exit settles a saved plan
 * only when it is that plan's own, rechecked where its result is written.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import type { UpdateState } from "@ceraui/rpc/schemas";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import { softwarePlanKey } from "../modules/system/software-update-attempt.ts";
import {
	type SoftwareUpdateAttempt,
	softwareUpdateOutputPaths,
} from "../modules/system/software-update-output.ts";
import {
	type DetachedAptUpgradeDeps,
	recoverDetachedAptUpgrade,
	resetSoftwareUpdateUnitForTest,
	runDetachedAptAll,
} from "../modules/system/software-update-process.ts";
import {
	beginSoftwareUpdateRecovery,
	getUpdateState,
	recoverSoftwareUpdateIfRunning,
} from "../modules/system/software-updates.ts";
import { persistRecoveredCommitSuccess } from "../modules/system/update-orchestrator/recovery-exit-gate.ts";
import { resumeOrchestratorState } from "../modules/system/update-orchestrator/resume.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { stopPackageInstallUnitForStream } from "../modules/system/update-orchestrator/stream-abort.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { abortSpyDeps } from "./helpers/orchestrator-runtime-stream-admission.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();
afterEach(() => {
	resetSoftwareUpdateUnitForTest();
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

const A = "11111111-1111-4111-8111-111111111111";
const INVOCATION_A = "a".repeat(32);
const args = buildAptAllInstallArgs(
	[{ name: "cerastream", version: "2" }],
	"any",
);
const quiet = { onStdout: () => {}, onStderr: () => {} };

type Unit = {
	kind: "running" | "finished";
	readonly invocation: string;
	exitCode: number;
	readonly packages?: readonly { name: string; version: string }[];
};

// systemd's one fixed unit and the device's record. A running unit finishes
// on the next poll unless `stays`; every retirement is logged.
function device(o: {
	unit?: Unit;
	record: SoftwareUpdateAttempt | null;
	readonly stays?: boolean;
	readonly transcript?: () => Promise<string | undefined>;
	readonly cleanup?: () => Promise<void>;
}) {
	const cleanups: string[] = [];
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: softwareUpdateOutputPaths(),
		uptimeMs: () => 1_000,
		readAttempt: () => o.record,
		updateAttempt: (change) => {
			const next = change(o.record);
			if (next) o.record = next;
			return next;
		},
		...(o.transcript ? { transcript: o.transcript } : {}),
		prepareOutput: async () => {},
		start: async () => {
			o.unit = { kind: "running", invocation: INVOCATION_A, exitCode: 0 };
		},
		inspect: async () => {
			const unit = o.unit;
			if (!unit) return { kind: "absent" };
			const own = {
				invocation: unit.invocation,
				...(unit.packages ? { packages: unit.packages } : {}),
			};
			return unit.kind === "running"
				? { kind: "running", ...own }
				: {
						kind: "finished",
						exitCode: unit.exitCode,
						cleanup: unit.exitCode === 0 ? "stop" : "reset-failed",
						...own,
					};
		},
		cleanup: async (state) => {
			await o.cleanup?.();
			cleanups.push(state.invocation ?? "");
			o.unit = undefined;
		},
		readOutput: async (_path, offset) => ({
			bytes: new Uint8Array(),
			nextOffset: offset,
		}),
		sleep: async () => {
			if (!o.stays && o.unit?.kind === "running") o.unit.kind = "finished";
		},
	};
	return { deps, cleanups, o };
}

const spawnSpy = () =>
	spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
		exitCode: 0,
		stdout: "",
		stderr: "",
	});

test("Go Live never stops a unit that has finished: its exit is left to its claim", async () => {
	const system = device({
		unit: { kind: "finished", invocation: INVOCATION_A, exitCode: 0 },
		record: null,
	});
	const spawn = spawnSpy();
	try {
		const stopped = await stopPackageInstallUnitForStream({
			commitStage: async () => false,
			deps: system.deps,
		});
		expect(stopped).toBe("finished");
		expect(spawn).not.toHaveBeenCalled();
		expect(system.o.unit).toMatchObject({ kind: "finished" });
	} finally {
		spawn.mockRestore();
	}
});

test("Go Live waits for the unit's lifecycle lock: a stop asked during the record-claim-retire step finds the unit retired", async () => {
	const inside = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const system = device({
		record: null,
		cleanup: async () => {
			inside.resolve();
			await release.promise;
		},
	});
	const spawn = spawnSpy();
	try {
		const run = runDetachedAptAll(args, "any", quiet, system.deps);
		await inside.promise;
		// The observer holds the lock between its claim and its stop.
		const stop = stopPackageInstallUnitForStream({
			commitStage: async () => false,
			deps: system.deps,
		});
		await Promise.resolve();
		expect(spawn).not.toHaveBeenCalled();
		release.resolve();
		expect(await run).toBe(0);
		expect(await stop).toBe("absent");
		expect(spawn).not.toHaveBeenCalled();
		expect(system.cleanups).toEqual([INVOCATION_A]);
	} finally {
		spawn.mockRestore();
	}
});

test("Go Live's stop is settled by what it found: a finished unit refuses the stream instead of reporting an abort", async () => {
	const { deps } = abortSpyDeps({
		getPackageInstallWireState: () =>
			({
				kind: "downloading",
				progress: { downloading: 1, unpacking: 0, setting_up: 0, total: 1 },
			}) as UpdateState,
		isCommitStageRunning: async () => false,
		stopPackageInstallUnit: async () => "finished",
	});
	setOrchestratorRuntimeDepsForTest(deps);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "downloading",
	});
	expect((await admitAndPrepareStreamStart()).allowed).toBe(false);
	expect(getOrchestratorState().phase).toBe("downloading");
});

test("a download Go Live interrupted is not reported as a failed update", async () => {
	await using h = await updateHarness();
	const system = device({
		unit: { kind: "running", invocation: INVOCATION_A, exitCode: 0 },
		record: {
			schema: 2,
			attempt: A,
			phase: "launched",
			uptimeMs: 1_000,
			invocation: INVOCATION_A,
		},
		stays: true,
	});
	const ended = Promise.withResolvers<void>();
	h.onFrame = (frame) => {
		if (frame.updating === null || frame.update_state?.kind === "failed")
			ended.resolve();
	};
	// Every systemctl Go Live runs ends the download: APT exits on its signal.
	const spawn = spyOn(spawnPolicy, "spawnWithTimeout").mockImplementation(
		async () => {
			if (system.o.unit) {
				system.o.unit.kind = "finished";
				system.o.unit.exitCode = 143;
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	);
	try {
		beginSoftwareUpdateRecovery();
		expect(
			await recoverSoftwareUpdateIfRunning({
				recover: (handlers, _deps, options) =>
					recoverDetachedAptUpgrade(handlers, system.deps, options),
				scheduleRetry: () => {},
				resumePeriodicChecks: () => {},
			}),
		).toBe(true);
		await stopPackageInstallUnitForStream({
			commitStage: async () => false,
			deps: system.deps,
		});
		await ended.promise;
		expect(h.frames.some((f) => f.update_state?.kind === "failed")).toBe(false);
		expect(getUpdateState().kind).not.toBe("failed");
		// Its exit was recorded and claimed, then the unit retired.
		expect(system.o.record).toMatchObject({ exitCode: 143 });
		expect(system.cleanups).toEqual([INVOCATION_A]);
	} finally {
		spawn.mockRestore();
	}
});

test("the outcome claimed before the retirement stays the outcome when the transcript cannot be read afterwards", async () => {
	// The stdout file reads the same for the record and both claims, then fails.
	let stats = 0;
	let handed: (() => Promise<unknown>) | undefined;
	const system = device({
		record: null,
		transcript: async () => (++stats <= 3 ? "1:10:1" : undefined),
	});
	expect(
		await runDetachedAptAll(
			args,
			"any",
			{
				...quiet,
				onOutcome: (claim) => {
					handed = claim;
				},
			},
			system.deps,
		),
	).toBe(0);
	expect(system.cleanups).toEqual([INVOCATION_A]);
	// The unit is gone: the outcome is the claim taken before it went.
	expect(await handed?.()).toMatchObject({ exitCode: 0, drained: true });
});

test("a finished unit's recorded exit stays told after its retirement, whatever the transcript reads then", async () => {
	let stats = 0;
	const system = device({
		unit: { kind: "finished", invocation: INVOCATION_A, exitCode: 0 },
		record: {
			schema: 2,
			attempt: A,
			phase: "launched",
			uptimeMs: 1_000,
			invocation: INVOCATION_A,
			exitCode: 0,
			drained: true,
			transcript: "1:10:1",
		},
		transcript: async () => (++stats <= 2 ? "1:10:1" : undefined),
	});
	const recovered = await recoverDetachedAptUpgrade(quiet, system.deps);
	expect(system.cleanups).toEqual([INVOCATION_A]);
	expect(recovered).toMatchObject({
		recorded: { attempt: A, exitCode: 0 },
		unit: "finished",
	});
});

test("a committing resume calls the unit absent only when the probe found none", async () => {
	const committing: OrchestratorState = {
		...initialOrchestratorState(0),
		phase: "committing",
	};
	const resume = (verdict: "absent" | "not-probed") =>
		resumeOrchestratorState(committing, {
			recoverSoftwareUpdateIfRunning: async () => false,
			lastInstallUnitVerdict: () => verdict,
			getUpdateState: () => ({ kind: "idle" }) as UpdateState,
			now: () => 1,
		});
	// A unit no attempt can claim, or a probe never run, is not absence.
	expect((await resume("not-probed")).failureReason).toBe(
		"commit_resume_inconclusive",
	);
	expect((await resume("absent")).failureReason).toBe(
		"commit_unit_absent_on_resume",
	);
});

test.each([
	["another plan's packages", "3", undefined],
	["the saved plan's own packages", "2", "bound"],
] as const)(
	"an older release's unit installing %s is bound to the saved plan only when they are its packages",
	async (_name, version, bound) => {
		const saved = softwarePlanKey([{ name: "cerastream", version: "2" }]);
		const system = device({
			unit: {
				kind: "running",
				invocation: INVOCATION_A,
				exitCode: 0,
				packages: [{ name: "cerastream", version }],
			},
			record: null,
		});
		const recovered = await recoverDetachedAptUpgrade(quiet, system.deps, {
			plan: () => saved,
		});
		expect(system.o.record).toMatchObject({ invocation: INVOCATION_A });
		expect(system.o.record?.plan).toBe(bound ? saved : undefined);
		if (recovered && "completion" in recovered) await recovered.completion;
	},
);

test("the recovered success is written only while its claim still holds at the write", async () => {
	let persisted = 0;
	const committing: OrchestratorState = {
		...initialOrchestratorState(0),
		phase: "committing",
	};
	const port = {
		snapshot: () => committing,
		pending: () => false,
		acquireControl: async () => ({
			held: () => true,
			[Symbol.asyncDispose]: async () => {},
		}),
		readPersisted: async () => committing,
		persist: () => {
			persisted++;
		},
	} as unknown as Parameters<typeof persistRecoveredCommitSuccess>[0];
	await persistRecoveredCommitSuccess(
		port,
		() => {},
		1,
		() => false,
	).catch(() => false);
	expect(persisted).toBe(0);
});

test("a failed commit is quarantined only while its claimed failure still holds after the reads before the write", async () => {
	const quarantine = testQuarantine();
	let recorded = 0;
	let failed = true;
	const readPending = quarantine.readPending.bind(quarantine);
	quarantine.readPending = async () => {
		// The claim stops holding while the pending list is read.
		failed = false;
		return readPending();
	};
	quarantine.recordPackageFailure = async () => {
		recorded++;
	};
	const { deps } = abortSpyDeps({
		quarantine,
		getPackageInstallWireState: () =>
			(failed
				? { kind: "failed", reason: "dpkg returned an error code (1)" }
				: { kind: "idle" }) as UpdateState,
	});
	setOrchestratorRuntimeDepsForTest(deps);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "committing",
	});
	await runOrchestratorTick();
	expect(recorded).toBe(0);
	expect(getOrchestratorState().phase).toBe("committing");
});
