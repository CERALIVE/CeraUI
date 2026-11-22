import { expect, spyOn, test } from "bun:test";
import type { UpdateProgress } from "@ceraui/rpc";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import * as readiness from "../modules/system/readiness.ts";
import { softwarePlanKey } from "../modules/system/software-update-attempt.ts";
import {
	SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
	type SoftwareUpdateAttempt,
	softwareUpdateOutputPaths,
} from "../modules/system/software-update-output.ts";
import {
	DetachedAptServiceAlreadyExistsError,
	DetachedAptServiceCleanupError,
	DetachedAptServiceReplacedError,
	DetachedAptServiceUnrecordedError,
	type DetachedAptUpgradeDeps,
	RECORDED_OUTCOME_REPLAY_MS,
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
	settleKeptSoftwareUpdateUnit,
} from "../modules/system/software-update-process.ts";
import {
	beginSoftwareUpdateRecovery,
	recoverSoftwareUpdateIfRunning,
	resetSoftwareUpdateState,
	runUpdateDiscoveryAndReport,
	type SoftwareUpdateRecoveryDeps,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import {
	reserveRecoveredUpdateExit,
	resetRecoveredUpdateExitForTest,
} from "../modules/system/update-orchestrator/recovery-exit-gate.ts";
import { defaultOrchestratorRuntimeDeps } from "../modules/system/update-orchestrator/runtime.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { TEST_PLAN, TEST_PLAN_PACKAGES } from "./helpers/memory-attempt.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

const paths = softwareUpdateOutputPaths();
// Boot-relative clock the records carry.
const NOW = 10 * 60 * 60_000;
const INVOCATION = "0123456789abcdef0123456789abcdef";
const attemptOf = (): SoftwareUpdateAttempt => ({
	schema: 2,
	attempt: "11111111-1111-4111-8111-111111111111",
	phase: "launched",
	uptimeMs: NOW,
	invocation: INVOCATION,
	drained: true,
});
type File = "stdout" | "stderr";
// A five-package plan: dpkg's ten steps (each package unpacked, then set
// up) make the number APT's transcript proves: `dpkgAt(60)` is the
// transcript once six steps are done and the seventh has started.
const PLAN =
	"The following packages will be upgraded:\n  cerastream libapp libb libc libd\n5 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n";
const PACKAGES = ["cerastream", "libapp", "libb", "libc", "libd"];
const STEPS = [
	...PACKAGES.map((name) => `Unpacking ${name} (2) over (1) ...\n`),
	...PACKAGES.map((name) => `Setting up ${name} (2) ...\n`),
];
const dpkgAt = (percent: number) =>
	PLAN + STEPS.slice(0, percent / 10 + 1).join("");
const fetches = (count: number) =>
	Array.from(
		{ length: count },
		(_, i) =>
			`Get:${i + 1} https://apt.invalid trixie/main arm64 p${i} 2 [1 kB]\n`,
	).join("");
const installingAt = (percent: number) => ({
	total: 1,
	downloading: 0,
	unpacking: 0,
	setting_up: 1,
	percent,
});

// A detached unit seen through the real observer: files grow, reads are
// bounded like production, and each poll runs the next scripted step.
function fakeUnit(o: {
	files: Record<File, string>;
	exitCode: number;
	failRead?: (file: File, attempt: number) => Error | undefined;
	steps?: (() => void)[];
	live?: boolean;
	failCleanup?: (attempt: number) => Error | undefined;
	firstRead?: Promise<void>;
	recorded?: Partial<SoftwareUpdateAttempt>;
	/** Exit records that fail: all, or the first N. */
	failRecord?: boolean | number;
	finished?: boolean;
	onFinish?: () => void;
}) {
	let state: "running" | "finished" | "absent" = o.live
		? "absent"
		: o.finished
			? "finished"
			: "running";
	const reads: Record<File, number> = { stdout: 0, stderr: 0 };
	const steps = [...(o.steps ?? [])];
	let polls = 0;
	let cleaned = 0;
	let cleanupAttempts = 0;
	const retired: string[] = [];
	const events: string[] = [];
	const started: (readonly string[])[] = [];
	let recorded: SoftwareUpdateAttempt | null = o.recorded
		? { ...attemptOf(), ...o.recorded }
		: null;
	let recordAttempts = 0;
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: paths,
		uptimeMs: () => NOW,
		readAttempt: () => recorded,
		updateAttempt: (change) => {
			const record = change(recorded);
			if (!record) return null;
			if (record.exitCode !== undefined) {
				recordAttempts++;
				if (
					o.failRecord === true ||
					(typeof o.failRecord === "number" && recordAttempts <= o.failRecord)
				)
					throw new Error("ENOSPC: /run is full");
				events.push("record");
			}
			recorded = record;
			return record;
		},
		prepareOutput: async () => {},
		start: async (command) => {
			started.push(command);
			state = "running";
		},
		inspect: async () =>
			state === "absent"
				? { kind: "absent" }
				: state === "finished"
					? {
							kind: "finished",
							exitCode: o.exitCode,
							cleanup: o.exitCode === 0 ? "stop" : "reset-failed",
							invocation: INVOCATION,
							packages: TEST_PLAN_PACKAGES,
						}
					: {
							kind: "running",
							invocation: INVOCATION,
							packages: TEST_PLAN_PACKAGES,
						},
		cleanup: async (finished) => {
			events.push("retire");
			const error = o.failCleanup?.(++cleanupAttempts);
			if (error) throw error;
			cleaned++;
			retired.push(finished.cleanup);
			state = "absent";
		},
		readOutput: async (path, offset) => {
			const file: File = path === paths.stdout ? "stdout" : "stderr";
			if (o.firstRead) await o.firstRead;
			reads[file]++;
			const error = o.failRead?.(file, reads[file]);
			if (error) throw error;
			const bytes = Buffer.from(o.files[file]);
			const block = bytes.subarray(
				offset,
				offset + SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
			);
			return { bytes: block, nextOffset: offset + block.byteLength };
		},
		sleep: async () => {
			if (++polls > 200) throw new Error("observer kept polling");
			const step = steps.shift();
			if (step) step();
			else if (state === "running") {
				o.onFinish?.();
				state = "finished";
			}
		},
	};
	return {
		deps,
		reads,
		retired,
		events,
		started,
		recorded: () => recorded,
		recordAttempts: () => recordAttempts,
		cleaned: () => cleaned,
		cleanupAttempts: () => cleanupAttempts,
	};
}

const running = (frames: { updating?: unknown }[]) =>
	frames.flatMap((frame) => {
		const u = frame.updating as UpdateProgress | null | undefined;
		return u && typeof u === "object" && u.result === undefined ? [u] : [];
	});

async function reattach(unit: ReturnType<typeof fakeUnit>) {
	let completion: Promise<number> | undefined;
	beginSoftwareUpdateRecovery();
	expect(
		await recoverSoftwareUpdateIfRunning({
			recover: async (handlers) => {
				const recovered = await recoverDetachedAptUpgrade(handlers, unit.deps);
				completion =
					recovered && "completion" in recovered
						? recovered.completion
						: undefined;
				return recovered;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		}),
	).toBe(true);
	return completion;
}

test("a running reattach announces only the state its files reach, not an older block", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({
		files: {
			stdout: `Reading package lists...\n${fetches(3_000)}${dpkgAt(60)}`,
			stderr: "",
		},
		exitCode: 100,
		steps: [() => {}],
	});
	expect(await await reattach(unit)).toBe(100);
	await h.settled();
	expect(running(h.frames)).toEqual([installingAt(60)]);
});

test("a first read error announces nothing until the unit's files are read", async () => {
	await using h = await updateHarness();
	let beforeRead: Record<string, unknown> | undefined;
	let framesBeforeRead = -1;
	const unit = fakeUnit({
		files: {
			stdout: `Reading package lists...\n${dpkgAt(60)}`,
			stderr: "",
		},
		exitCode: 100,
		failRead: (file, attempt) =>
			file === "stdout" && attempt === 1 ? new Error("EIO") : undefined,
		steps: [
			() => {
				beforeRead = buildInitialStatus().status;
				framesBeforeRead = running(h.frames).length;
			},
			() => {},
		],
	});
	expect(await await reattach(unit)).toBe(100);
	await h.settled();
	expect(beforeRead).not.toHaveProperty("updating");
	expect(beforeRead).not.toHaveProperty("update_state");
	expect(framesBeforeRead).toBe(0);
	expect(running(h.frames)).toEqual([installingAt(60)]);
});

const args = buildAptAllInstallArgs(
	[{ name: "cerastream", version: "2" }],
	"any",
);
const quiet = { onStdout: () => {}, onStderr: () => {} };
const eio = () => new Error("EIO");

test.each([
	["stdout is unreadable", "stdout", eio, 0, false],
	["stdout is unreadable", "stdout", eio, 100, false],
	["stdout is unreadable", "stdout", eio, 137, false],
	["stderr is unreadable", "stderr", eio, 100, false],
] as const)(
	"when %s, exit %d stays the outcome and the unit stays as the evidence",
	async (_name, faulty, error, exitCode, readable) => {
		const unit = fakeUnit({
			files: { stdout: "done\n", stderr: "" },
			exitCode,
			failRead: (file) => (file === faulty ? error() : undefined),
			live: true,
		});
		const retirement = exitCode === 0 ? "stop" : "reset-failed";
		expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(
			exitCode,
		);
		expect(unit.recorded()?.exitCode).toBe(exitCode);
		// A unit whose transcript could not be read stays as recovery evidence.
		expect(unit.retired).toEqual(readable ? [retirement] : []);
		expect(unit.recorded()?.drained).toBe(readable);
		// The next launch never retires an unread outcome: it refuses instead.
		await expect(
			runDetachedAptAll(args, "any", quiet, unit.deps),
		).rejects.toBeInstanceOf(DetachedAptServiceAlreadyExistsError);
		expect(unit.retired).toEqual(readable ? [retirement] : []);
		expect(unit.started).toHaveLength(1);
	},
);

test("a retirement that fails once is retried and the outcome stands", async () => {
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "" },
		exitCode: 0,
		failCleanup: (attempt) =>
			attempt === 1 ? new Error("systemctl stop failed") : undefined,
		live: true,
	});
	expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(0);
	expect(unit.cleanupAttempts()).toBe(2);
	expect(unit.retired).toEqual(["stop"]);
});

test("a retirement retry inspects again and leaves a unit that replaced the one it validated", async () => {
	let replaced = false;
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "" },
		exitCode: 0,
		failCleanup: (attempt) => {
			if (attempt !== 1) return undefined;
			// Another invocation of the fixed unit takes the name before the retry.
			replaced = true;
			return new Error("systemctl stop failed");
		},
		live: true,
	});
	const inspect = unit.deps.inspect;
	Object.assign(unit.deps, {
		inspect: async () =>
			replaced ? { ...(await inspect()), invocation: OTHER } : inspect(),
	});
	expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(0);
	expect(unit.recorded()?.exitCode).toBe(0);
	expect(unit.cleanupAttempts()).toBe(1);
	expect(unit.retired).toEqual([]);
});

test("a unit that cannot be retired keeps its exit status and the next start settles it first", async () => {
	let broken = true;
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "" },
		exitCode: 0,
		failCleanup: () =>
			broken ? new Error("systemctl stop failed") : undefined,
		live: true,
	});
	const failed = await runDetachedAptAll(args, "any", quiet, unit.deps).catch(
		(error: unknown) => error,
	);
	expect(failed).toBeInstanceOf(DetachedAptServiceCleanupError);
	expect((failed as DetachedAptServiceCleanupError).transactionExitCode).toBe(
		0,
	);
	expect(unit.cleanupAttempts()).toBeGreaterThan(1);
	// No launch starts past it: the start settles it first, claimed then retired.
	await expect(
		runDetachedAptAll(args, "any", quiet, unit.deps),
	).rejects.toBeInstanceOf(DetachedAptServiceAlreadyExistsError);
	expect(unit.started).toHaveLength(1);
	broken = false;
	expect(await settleKeptSoftwareUpdateUnit(unit.deps)).toBe(true);
	expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(0);
	expect(unit.retired).toEqual(["stop", "stop"]);
});

function recoveryOf(
	unit: ReturnType<typeof fakeUnit>,
	probe: () => void = () => {},
): SoftwareUpdateRecoveryDeps & { completion?: Promise<number> } {
	const deps: SoftwareUpdateRecoveryDeps & { completion?: Promise<number> } = {
		recover: async (handlers, _service, options) => {
			probe();
			const recovered = await recoverDetachedAptUpgrade(
				handlers,
				unit.deps,
				options,
			);
			deps.completion =
				recovered && "completion" in recovered
					? recovered.completion
					: undefined;
			return recovered;
		},
		scheduleRetry: () => {},
		resumePeriodicChecks: () => {},
	};
	return deps;
}

const installing = {
	stdout: `Preparing to unpack .../cerastream_2_arm64.deb ...\n${dpkgAt(60)}`,
	stderr: "",
};

test("a second recovery call while the first observer has read nothing changes nothing", async () => {
	await using h = await updateHarness();
	const read = Promise.withResolvers<void>();
	let probes = 0;
	const unit = fakeUnit({
		files: installing,
		exitCode: 0,
		firstRead: read.promise,
	});
	const deps = recoveryOf(unit, () => probes++);
	beginSoftwareUpdateRecovery();
	expect(await recoverSoftwareUpdateIfRunning(deps)).toBe(true);
	// The orchestrator's resume reattached; main's standalone call comes second.
	expect(await recoverSoftwareUpdateIfRunning(deps)).toBe(true);
	expect(probes).toBe(1);
	expect(buildInitialStatus().status).not.toHaveProperty("updating");
	expect(buildInitialStatus().status).not.toHaveProperty("update_state");
	expect(h.frames.some((frame) => "updating" in frame)).toBe(false);
	read.resolve();
	expect(await deps.completion).toBe(0);
	await h.settled();
	expect(running(h.frames)).toEqual([installingAt(60)]);
});

test.each([0, 100])(
	"after a refused bootstrap a running unit still ends in its own exit %d, and is left for its owner",
	async (exitCode) => {
		await using h = await updateHarness();
		const unit = fakeUnit({ files: installing, exitCode, steps: [() => {}] });
		const deps = recoveryOf(unit);
		beginSoftwareUpdateRecovery();
		await recoverSoftwareUpdateIfRunning(deps, Promise.resolve(false));
		expect(await deps.completion).toBe(exitCode);
		await h.settled();
		expect(running(h.frames)).toEqual([installingAt(60)]);
		const outcome = h.frames.at(-1);
		expect(outcome?.update_state?.kind).toBe(
			exitCode === 0 ? "success" : "failed",
		);
		expect(unit.cleaned()).toBe(0);
		expect(h.restarts).toBe(0);
		expect(h.cleanCount).toBe(0);
	},
);

test("after a refused bootstrap a unit proven absent tells the tab null", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({ files: installing, exitCode: 0, live: true });
	beginSoftwareUpdateRecovery();
	await recoverSoftwareUpdateIfRunning(
		recoveryOf(unit),
		Promise.resolve(false),
	);
	expect(buildInitialStatus().status).toHaveProperty("updating", null);
	expect(h.frames.at(-1)?.updating).toBeNull();
});

test("after a refused bootstrap a failed probe is retried, never taken for an answer", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({ files: installing, exitCode: 0, steps: [() => {}] });
	let retry: (() => void) | undefined;
	let failures = 1;
	const deps: SoftwareUpdateRecoveryDeps & { completion?: Promise<number> } = {
		...recoveryOf(unit),
		scheduleRetry: (again) => {
			retry = again;
		},
	};
	const recover = deps.recover;
	Object.assign(deps, {
		recover: (async (...args: Parameters<typeof recover>) => {
			if (failures-- > 0) throw new Error("systemctl show failed");
			return recover(...args);
		}) as typeof recover,
	});
	beginSoftwareUpdateRecovery();
	await expect(
		recoverSoftwareUpdateIfRunning(deps, Promise.resolve(false)),
	).rejects.toThrow("systemctl show failed");
	expect(buildInitialStatus().status).not.toHaveProperty("updating");
	expect(retry).toBeDefined();
	retry?.();
	await h.settled();
	expect(running(h.frames)).toEqual([installingAt(60)]);
	expect(h.frames.at(-1)?.update_state?.kind).toBe("success");
});

test("the observer records the exit after its final read, then retires the unit", async () => {
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "" },
		exitCode: 0,
		live: true,
	});
	expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(0);
	expect(unit.events).toEqual(["record", "retire"]);
	expect(unit.recorded()?.exitCode).toBe(0);
});

test.each([0, 100])(
	"a finished unit whose exit %d an earlier lifetime recorded is never adopted again",
	async (exitCode) => {
		await using h = await updateHarness();
		const unit = fakeUnit({
			files: installing,
			exitCode,
			finished: true,
			recorded: { exitCode, uptimeMs: NOW - 2 * RECORDED_OUTCOME_REPLAY_MS },
			failCleanup: () => new Error("systemctl stop failed"),
		});
		const deps = recoveryOf(unit);
		beginSoftwareUpdateRecovery();
		expect(await recoverSoftwareUpdateIfRunning(deps)).toBe(true);
		expect(deps.completion).toBeUndefined();
		expect(running(h.frames)).toEqual([]);
		expect(unit.cleanupAttempts()).toBe(1);
		expect(h.restarts).toBe(0);
		expect(h.cleanCount).toBe(0);
		expect(buildInitialStatus().status.update_state?.kind).toBe(
			exitCode === 0 ? "success" : "failed",
		);
		expect(h.frames.at(-1)?.updating).toBeNull();
	},
);

test.each([
	[0, "success"],
	[100, "failed"],
] as const)(
	"a retired unit's recorded exit %d is what a reconnecting tab is told",
	async (exitCode, kind) => {
		await using h = await updateHarness();
		const unit = fakeUnit({
			files: installing,
			exitCode,
			live: true,
			recorded: { exitCode },
		});
		beginSoftwareUpdateRecovery();
		expect(await recoverSoftwareUpdateIfRunning(recoveryOf(unit))).toBe(false);
		const status = buildInitialStatus().status;
		expect(status.updating).toBeNull();
		expect(status.update_state?.kind).toBe(kind);
		expect(h.frames.at(-1)?.update_state?.kind).toBe(kind);
		expect(h.restarts).toBe(0);
	},
);

test("a recorded outcome older than the replay window is not told again", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({
		files: installing,
		exitCode: 0,
		live: true,
		recorded: { exitCode: 0, uptimeMs: NOW - RECORDED_OUTCOME_REPLAY_MS - 1 },
	});
	beginSoftwareUpdateRecovery();
	expect(await recoverSoftwareUpdateIfRunning(recoveryOf(unit))).toBe(false);
	expect(buildInitialStatus().status.update_state?.kind).not.toBe("success");
	expect(h.frames.at(-1)?.updating).toBeNull();
});

test.each([
	["can never be retired and whose exit is recorded", false, true, 1, 1],
	[
		"can never be retired and whose exit could not be recorded",
		true,
		true,
		0,
		5,
	],
	["could be retired but whose exit could not be recorded", true, false, 0, 5],
] as const)(
	"a successful unit that %s restarts CeraUI at most once over five boots",
	async (_name, failRecord, failCleanup, restarts, adoptions) => {
		// An exit nothing could record cannot be claimed: it is no outcome.
		const told = failRecord ? "available" : "success";
		await using h = await updateHarness();
		const unit = fakeUnit({
			files: installing,
			exitCode: 0,
			finished: true,
			failRecord,
			...(failCleanup
				? { failCleanup: () => new Error("systemctl stop failed") }
				: {}),
		});
		let adopted = 0;
		for (let boot = 1; boot <= 5; boot++) {
			resetSoftwareUpdateState();
			beginSoftwareUpdateRecovery();
			const deps = recoveryOf(unit);
			expect(await recoverSoftwareUpdateIfRunning(deps)).toBe(true);
			if (deps.completion) adopted++;
			expect(buildInitialStatus().status.update_state?.kind).toBe(told);
		}
		expect(adopted).toBe(adoptions);
		expect(h.restarts).toBe(restarts);
		// Without a durable record the finished unit is the only evidence: it stays.
		if (failRecord) expect(unit.retired).toEqual([]);
	},
);

test("every launch runs the released command, which gives APT no telemetry descriptor", async () => {
	const unit = fakeUnit({
		files: { stdout: "Unpacking cerastream\n", stderr: "" },
		exitCode: 0,
		live: true,
	});
	expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(0);
	const command = unit.started[0] ?? [];
	expect(command.join(" ")).not.toContain("Status-Fd");
	expect(command.slice(-3, -1)).toEqual(["/bin/sh", "-ec"]);
});

test("a launch never retires a finished unit whose exit nobody recorded", async () => {
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "" },
		exitCode: 0,
		finished: true,
	});
	await expect(
		runDetachedAptAll(args, "any", quiet, unit.deps),
	).rejects.toBeInstanceOf(DetachedAptServiceAlreadyExistsError);
	expect(unit.cleanupAttempts()).toBe(0);
	expect(unit.started).toEqual([]);
});

test("the read after the unit is inactive is complete, so its last records are shown", async () => {
	await using h = await updateHarness();
	const files = { ...installing };
	const unit = fakeUnit({
		files,
		exitCode: 0,
		steps: [() => {}],
		onFinish: () => {
			files.stdout += STEPS.slice(7, 10).join("");
		},
	});
	expect(await await reattach(unit)).toBe(0);
	await h.settled();
	expect(running(h.frames)).toEqual([installingAt(60), installingAt(90)]);
});

test.each([
	["a running unit", {}, false],
	["a finished unit nobody recorded", { finished: true }, false],
	[
		"a finished, recorded unit the start settles first",
		{ finished: true, recorded: { exitCode: 0 } },
		true,
	],
] as const)(
	"a launch starts past %s only when no unit is left",
	async (_name, o, starts) => {
		const unit = fakeUnit({ files: installing, exitCode: 0, ...o });
		// A launch never starts past a unit, nor retires one itself.
		await expect(
			runDetachedAptAll(args, "any", quiet, unit.deps),
		).rejects.toBeInstanceOf(DetachedAptServiceAlreadyExistsError);
		expect(unit.started).toEqual([]);
		if (starts) {
			// The start settles it: its recorded outcome claimed, then the unit retired.
			expect(await settleKeptSoftwareUpdateUnit(unit.deps)).toBe(true);
			expect(unit.retired[0]).toBe("stop");
			await runDetachedAptAll(args, "any", quiet, unit.deps);
			expect(unit.started).toHaveLength(1);
		} else {
			if (o.finished)
				expect(await settleKeptSoftwareUpdateUnit(unit.deps)).toBe(false);
			expect(unit.cleaned()).toBe(0);
			expect(unit.started).toEqual([]);
		}
	},
);

test.each([
	["always", true, false],
	["twice, then not", 2, true],
] as const)(
	"an outcome record that fails %s: only a recorded exit is the outcome, and the unit is retired only once it is recorded",
	async (_name, failRecord, kept) => {
		const unit = fakeUnit({
			files: { stdout: "done\n", stderr: "" },
			exitCode: 0,
			live: true,
			failRecord,
		});
		const run = runDetachedAptAll(args, "any", quiet, unit.deps);
		if (kept) expect(await run).toBe(0);
		else
			await expect(run).rejects.toBeInstanceOf(
				DetachedAptServiceUnrecordedError,
			);
		expect(unit.recordAttempts()).toBe(kept ? 3 : 5);
		expect(unit.recorded()?.exitCode).toBe(kept ? 0 : undefined);
		expect(unit.retired).toEqual(kept ? ["stop"] : []);
	},
);

test("a truncated last record is never shown", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({
		files: {
			...installing,
			stdout: `${installing.stdout}Setting up libb (2`,
		},
		exitCode: 0,
		steps: [() => {}],
	});
	expect(await await reattach(unit)).toBe(0);
	await h.settled();
	expect(running(h.frames)).toEqual([installingAt(60)]);
});

test.each([
	["its recorded success", { exitCode: 0 }, "success"],
	["no recorded exit", undefined, "available"],
] as const)(
	"a boot whose unit is gone settles from %s before startup adjudication",
	async (_name, recorded, kind) => {
		await using h = await updateHarness();
		const unit = fakeUnit({
			files: installing,
			exitCode: 0,
			live: true,
			...(recorded ? { recorded } : {}),
		});
		beginSoftwareUpdateRecovery();
		expect(buildInitialStatus().status.updating).toBeUndefined();
		const adjudication = Promise.withResolvers<boolean>();
		await recoverSoftwareUpdateIfRunning(
			recoveryOf(unit),
			adjudication.promise,
		);
		expect(h.frames.at(-1)?.updating).toBeNull();
		expect(buildInitialStatus().status.update_state?.kind).toBe(kind);
		adjudication.resolve(true);
	},
);

test("a boot whose unit still runs shows its progress before startup adjudication", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({ files: installing, exitCode: 0, steps: [() => {}] });
	const deps = recoveryOf(unit);
	beginSoftwareUpdateRecovery();
	const adjudication = Promise.withResolvers<boolean>();
	expect(await recoverSoftwareUpdateIfRunning(deps, adjudication.promise)).toBe(
		true,
	);
	expect(await deps.completion).toBe(0);
	await h.settled();
	expect(running(h.frames)).toEqual([installingAt(60)]);
	expect(h.frames.at(-1)?.update_state?.kind).toBe("success");
	// Watching is not owning: nothing is retired, cleaned or restarted yet.
	expect(unit.retired).toEqual([]);
	expect(h.cleanCount).toBe(0);
	expect(h.restarts).toBe(0);
	adjudication.resolve(true);
	await h.restarted();
	expect(unit.retired).toEqual(["stop"]);
	expect(h.cleanCount).toBe(1);
	expect(h.restarts).toBe(1);
});

test.each([0, 100])(
	"a finished unit seen before startup adjudication is told at once, and is left alone when adjudication refuses (exit %d)",
	async (exitCode) => {
		await using h = await updateHarness();
		const unit = fakeUnit({ files: installing, exitCode, finished: true });
		const deps = recoveryOf(unit);
		beginSoftwareUpdateRecovery();
		const adjudication = Promise.withResolvers<boolean>();
		expect(
			await recoverSoftwareUpdateIfRunning(deps, adjudication.promise),
		).toBe(true);
		expect(buildInitialStatus().status.update_state?.kind).toBe(
			exitCode === 0 ? "success" : "failed",
		);
		expect(unit.recorded()?.exitCode).toBe(exitCode);
		adjudication.resolve(false);
		await h.settled();
		expect(unit.retired).toEqual([]);
		expect(h.cleanCount).toBe(0);
		expect(h.restarts).toBe(0);
	},
);

const OTHER = "fedcba9876543210fedcba9876543210";

test("a finished unit of another invocation than the recorded exit is observed, never taken as recorded", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({
		files: installing,
		exitCode: 0,
		finished: true,
		recorded: { exitCode: 0, invocation: OTHER },
	});
	const deps = recoveryOf(unit);
	beginSoftwareUpdateRecovery();
	expect(await recoverSoftwareUpdateIfRunning(deps)).toBe(true);
	expect(deps.completion).toBeDefined();
	expect(await deps.completion).toBe(0);
	expect(unit.recorded()?.invocation).toBe(INVOCATION);
	expect(unit.recorded()?.attempt).not.toBe(attemptOf().attempt);
	await h.settled();
});

test("an exit is never written over a newer attempt's record", async () => {
	const newer = {
		schema: 2 as const,
		attempt: "22222222-2222-4222-8222-222222222222",
		phase: "accepted" as const,
		uptimeMs: NOW,
	};
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "" },
		exitCode: 0,
		live: true,
		steps: [() => unit.deps.updateAttempt(() => newer)],
	});
	// The exit is not the newer attempt's outcome: nobody is told it.
	await expect(
		runDetachedAptAll(args, "any", quiet, unit.deps),
	).rejects.toBeInstanceOf(DetachedAptServiceReplacedError);
	expect(unit.recorded()).toEqual(newer);
	expect(unit.recordAttempts()).toBe(0);
	// Not recorded, so not retired: the unit stays as the evidence.
	expect(unit.retired).toEqual([]);
});

test("a retirement deferred until startup is admitted leaves a unit that was replaced meanwhile", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({ files: installing, exitCode: 0, finished: true });
	const deps = recoveryOf(unit);
	beginSoftwareUpdateRecovery();
	const adjudication = Promise.withResolvers<boolean>();
	expect(await recoverSoftwareUpdateIfRunning(deps, adjudication.promise)).toBe(
		true,
	);
	expect(unit.recorded()?.exitCode).toBe(0);
	// Another invocation of the fixed unit appears before startup hands it over.
	const inspect = unit.deps.inspect;
	Object.assign(unit.deps, {
		inspect: async () => ({ ...(await inspect()), invocation: OTHER }),
	});
	const degraded = Promise.withResolvers<string>();
	const mark = spyOn(readiness, "markBootDegraded").mockImplementation(
		(subsystem) => degraded.resolve(subsystem),
	);
	try {
		adjudication.resolve(true);
		// A unit that is no longer the one observed restarts nothing.
		expect(await degraded.promise).toBe("software-update-replaced");
		expect(h.restarts).toBe(0);
		expect(unit.retired).toEqual([]);
	} finally {
		mark.mockRestore();
	}
});

test("the completion hook startup reserves after the unit was attached is the one that guards the restart", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({ files: installing, exitCode: 0, finished: true });
	const deps = recoveryOf(unit);
	beginSoftwareUpdateRecovery();
	const adjudication = Promise.withResolvers<boolean>();
	try {
		expect(
			await recoverSoftwareUpdateIfRunning(deps, adjudication.promise),
		).toBe(true);
		let checked = 0;
		reserveRecoveredUpdateExit(async () => {
			checked++;
			return true;
		});
		adjudication.resolve(true);
		await h.restarted();
		expect(checked).toBe(1);
	} finally {
		resetRecoveredUpdateExitForTest();
	}
});

test("an exit recorded without its transcript keeps the unit on the next boot too", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({
		files: installing,
		exitCode: 0,
		finished: true,
		failRead: (file) => (file === "stdout" ? eio() : undefined),
	});
	beginSoftwareUpdateRecovery();
	const first = recoveryOf(unit);
	expect(await recoverSoftwareUpdateIfRunning(first)).toBe(true);
	expect(unit.recorded()?.exitCode).toBe(0);
	expect(unit.recorded()?.drained).toBe(false);
	// The next lifetime finds that recorded exit: told, never adopted, not retired.
	resetSoftwareUpdateState();
	beginSoftwareUpdateRecovery();
	const second = recoveryOf(unit);
	expect(await recoverSoftwareUpdateIfRunning(second)).toBe(true);
	expect(second.completion).toBeUndefined();
	expect(unit.retired).toEqual([]);
	expect(buildInitialStatus().status.update_state?.kind).toBe("success");
	await h.settled();
});

test("a stale exit retry never replaces a newer attempt's recorded failure", async () => {
	const newer = {
		schema: 2 as const,
		attempt: "22222222-2222-4222-8222-222222222222",
		phase: "launched" as const,
		uptimeMs: NOW,
		invocation: OTHER,
		exitCode: 100,
		drained: true,
	};
	// This observer's first exit write fails; before its retry, a newer
	// attempt's unit records its failure.
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "" },
		exitCode: 0,
		live: true,
		failRecord: 1,
	});
	const sleep = unit.deps.sleep;
	let installed = false;
	Object.assign(unit.deps, {
		sleep: async (ms: number) => {
			if (!installed && unit.recordAttempts() === 1) {
				installed = true;
				unit.deps.updateAttempt(() => newer);
				return;
			}
			return sleep(ms);
		},
	});
	await runDetachedAptAll(args, "any", quiet, unit.deps).catch(() => undefined);
	expect(installed).toBe(true);
	expect(unit.recorded()).toEqual(newer);
	expect(unit.retired).toEqual([]);
});

test("the first retirement asks systemd again and leaves a unit that replaced the one observed", async () => {
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "" },
		exitCode: 0,
		live: true,
	});
	const inspect = unit.deps.inspect;
	Object.assign(unit.deps, {
		inspect: async () =>
			unit.events.includes("record")
				? { ...(await inspect()), invocation: OTHER }
				: inspect(),
	});
	expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(0);
	expect(unit.recorded()?.exitCode).toBe(0);
	expect(unit.cleanupAttempts()).toBe(0);
	expect(unit.retired).toEqual([]);
});

test("a recorded exit is not told once another run has rewritten the transcript", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({
		files: { stdout: "", stderr: "" },
		exitCode: 0,
		live: true,
		recorded: { exitCode: 0, drained: true, transcript: "7:120:1000" },
	});
	Object.assign(unit.deps, { transcript: async () => "8:64:2000" });
	beginSoftwareUpdateRecovery();
	expect(await recoverSoftwareUpdateIfRunning(recoveryOf(unit))).toBe(false);
	expect(buildInitialStatus().status.update_state?.kind).not.toBe("success");
	expect(h.frames.some((frame) => frame.update_state?.kind === "success")).toBe(
		false,
	);
});

test("a recorded exit is told while the transcript is the one it was recorded against", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({
		files: { stdout: "", stderr: "" },
		exitCode: 0,
		live: true,
		recorded: { exitCode: 0, drained: true, transcript: "7:120:1000" },
	});
	Object.assign(unit.deps, { transcript: async () => "7:120:1000" });
	beginSoftwareUpdateRecovery();
	await recoverSoftwareUpdateIfRunning(recoveryOf(unit));
	expect(buildInitialStatus().status.update_state?.kind).toBe("success");
	expect(h.restarts).toBe(0);
});

test("a replay is not told once a newer admission lands while it reads the transcript", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({
		files: { stdout: "", stderr: "" },
		exitCode: 0,
		live: true,
		recorded: { exitCode: 0, drained: true, transcript: "7:120:1000" },
	});
	// B is admitted between the replay's record read and its transcript read.
	Object.assign(unit.deps, {
		transcript: async () => {
			unit.deps.updateAttempt(() => ({
				schema: 2,
				attempt: "22222222-2222-4222-8222-222222222222",
				phase: "accepted",
				uptimeMs: NOW,
			}));
			return "7:120:1000";
		},
	});
	beginSoftwareUpdateRecovery();
	expect(await recoverSoftwareUpdateIfRunning(recoveryOf(unit))).toBe(false);
	expect(buildInitialStatus().status.update_state?.kind).not.toBe("success");
	expect(h.frames.some((frame) => frame.update_state?.kind === "success")).toBe(
		false,
	);
});

test("an exit whose transcript could not be read never restarts CeraUI", async () => {
	await using h = await updateHarness();
	const unit = fakeUnit({
		files: installing,
		exitCode: 0,
		finished: true,
		failRead: (file) => (file === "stdout" ? new Error("EIO") : undefined),
	});
	const degraded = Promise.withResolvers<string>();
	const mark = spyOn(readiness, "markBootDegraded").mockImplementation(
		(subsystem) => degraded.resolve(subsystem),
	);
	try {
		beginSoftwareUpdateRecovery();
		expect(await recoverSoftwareUpdateIfRunning(recoveryOf(unit))).toBe(true);
		// Whichever comes first: the old code restarted CeraUI instead.
		expect(
			await Promise.race([
				degraded.promise,
				h.restarted().then(() => "restarted"),
			]),
		).toBe("software-update-unproven");
		expect(h.restarts).toBe(0);
		expect(unit.recorded()?.drained).toBe(false);
		expect(unit.retired).toEqual([]);
	} finally {
		mark.mockRestore();
	}
});

test.each([
	[undefined, "idle"],
	[TEST_PLAN, "success"],
	[softwarePlanKey([{ name: "cerastream", version: "3" }]), "idle"],
] as const)(
	"the orchestrator settles its plan only from an exit the current saved plan's own attempt claimed (plan %s)",
	async (plan, kind) => {
		await using h = await updateHarness();
		const unit = fakeUnit({
			files: { stdout: "", stderr: "" },
			exitCode: 0,
			live: true,
			recorded: { exitCode: 0, ...(plan ? { plan } : {}) },
		});
		beginSoftwareUpdateRecovery();
		await recoverSoftwareUpdateIfRunning(recoveryOf(unit));
		// The tab is told the device's outcome either way.
		expect(buildInitialStatus().status.update_state?.kind).toBe("success");
		expect(h.restarts).toBe(0);
		// The plan settles only from its own attempt's claimed exit.
		expect(
			defaultOrchestratorRuntimeDeps.getPackageInstallWireState().kind,
		).toBe(kind);
	},
);

test("a second start while the first waits for discovery is refused", async () => {
	await using _h = await updateHarness();
	const discovery = Promise.withResolvers<{
		exitCode: number;
		stdout: string;
		stderr: string;
	}>();
	const spawn = spyOn(spawnPolicy, "spawnWithTimeout").mockReturnValue(
		discovery.promise as ReturnType<typeof spawnPolicy.spawnWithTimeout>,
	);
	const running = runUpdateDiscoveryAndReport();
	try {
		// The first start waits for discovery and admits its own attempt then.
		expect(startSoftwareUpdate()).toEqual({ started: true });
		// A second one would admit an attempt over the waiting one's record.
		expect(startSoftwareUpdate()).toMatchObject({
			started: false,
			reason: "already_updating",
		});
	} finally {
		discovery.resolve({
			exitCode: 1,
			stdout:
				"The following packages will be upgraded:\n  cerastream\n1 upgraded, 0 newly installed, 0 to remove.\n",
			stderr: "",
		});
		await running;
		spawn.mockRestore();
	}
});
