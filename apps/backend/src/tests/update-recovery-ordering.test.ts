import { expect, test } from "bun:test";
import type { UpdateProgress } from "@ceraui/rpc";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import {
	SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
	type SoftwareUpdateAttempt,
	softwareUpdateOutputPaths,
} from "../modules/system/software-update-output.ts";
import {
	DetachedAptServiceAlreadyExistsError,
	DetachedAptServiceCleanupError,
	type DetachedAptUpgradeDeps,
	RECORDED_OUTCOME_REPLAY_MS,
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
} from "../modules/system/software-update-process.ts";
import {
	beginSoftwareUpdateRecovery,
	recoverSoftwareUpdateIfRunning,
	resetSoftwareUpdateState,
	type SoftwareUpdateRecoveryDeps,
} from "../modules/system/software-updates.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

const paths = softwareUpdateOutputPaths();
// Boot-relative clock the records carry.
const NOW = 10 * 60 * 60_000;
const attemptOf = (): SoftwareUpdateAttempt => ({
	schema: 2,
	attempt: "11111111-1111-4111-8111-111111111111",
	phase: "launched",
	uptimeMs: NOW,
});
type File = "stdout" | "stderr" | "status";
const dl = (percent: string) =>
	`dlstatus:1:${percent}:Retrieving file 1 of 1\n`;
const pm = (percent: string) =>
	`pmstatus:cerastream:${percent}:Unpacking cerastream\n`;
const dpkgExec = "pmstatus:dpkg-exec:0.0000:Running dpkg\n";
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
	const reads: Record<File, number> = { stdout: 0, stderr: 0, status: 0 };
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
		writeAttempt: (record) => {
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
							aptStatus: true,
						}
					: { kind: "running", aptStatus: true },
		cleanup: async (finished) => {
			events.push("retire");
			const error = o.failCleanup?.(++cleanupAttempts);
			if (error) throw error;
			cleaned++;
			retired.push(finished.cleanup);
			state = "absent";
		},
		readOutput: async (path, offset) => {
			const file: File =
				path === paths.stdout
					? "stdout"
					: path === paths.stderr
						? "stderr"
						: "status";
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
			stdout: "Reading package lists...\n",
			stderr: "",
			status: `${dl("96.0000").repeat(3_000)}${dpkgExec}${pm("60.0000")}`,
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
			stdout: "Reading package lists...\n",
			stderr: "",
			status: `${dpkgExec}${pm("60.0000")}`,
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

const enoent = () =>
	Object.assign(new Error("ENOENT: no such file or directory"), {
		code: "ENOENT",
	});

const args = buildAptAllInstallArgs(
	[{ name: "cerastream", version: "2" }],
	"any",
);
const quiet = { onStdout: () => {}, onStderr: () => {}, onStatus: () => {} };
const eio = () => new Error("EIO");

test.each([
	["the status file is unreadable", "status", eio, 0, true],
	["the status file is unreadable", "status", eio, 100, true],
	["the status file is missing", "status", enoent, 0, true],
	["the status file is unreadable", "status", eio, 137, true],
	["stdout is unreadable", "stdout", eio, 0, false],
	["stdout is unreadable", "stdout", eio, 100, false],
	["stdout is unreadable", "stdout", eio, 137, false],
	["stderr is unreadable", "stderr", eio, 100, false],
] as const)(
	"when %s, exit %d stays the outcome and the next update starts",
	async (_name, faulty, error, exitCode, readable) => {
		const unit = fakeUnit({
			files: { stdout: "done\n", stderr: "", status: "" },
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
		// Its exit is recorded, so the next launch may retire it and start.
		expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(
			exitCode,
		);
		expect(unit.retired).toEqual(
			readable ? [retirement, retirement] : [retirement],
		);
	},
);

test("a retirement that fails once is retried and the outcome stands", async () => {
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "", status: "" },
		exitCode: 0,
		failCleanup: (attempt) =>
			attempt === 1 ? new Error("systemctl stop failed") : undefined,
		live: true,
	});
	expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(0);
	expect(unit.cleanupAttempts()).toBe(2);
	expect(unit.retired).toEqual(["stop"]);
});

test("a unit that cannot be retired keeps its exit status and the next launch retires it", async () => {
	let broken = true;
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "", status: "" },
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
	broken = false;
	expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(0);
	expect(unit.retired).toEqual(["stop", "stop"]);
});

test("a status file that could not be prepared is never read", async () => {
	const unit = fakeUnit({
		files: {
			stdout: "Unpacking cerastream\n",
			stderr: "",
			status: pm("50.0000"),
		},
		exitCode: 0,
		live: true,
	});
	expect(
		await runDetachedAptAll(args, "any", quiet, {
			...unit.deps,
			prepareOutput: async () => ({ status: false }),
		}),
	).toBe(0);
	expect(unit.reads.status).toBe(0);
});

test("a status file that appears late still reports APT's records", async () => {
	let status = "";
	const unit = fakeUnit({
		files: { stdout: "", stderr: "", status: `${dpkgExec}${pm("40.0000")}` },
		exitCode: 0,
		failRead: (file, attempt) =>
			file === "status" && attempt <= 2 ? enoent() : undefined,
		steps: [() => {}, () => {}],
		live: true,
	});
	const args = buildAptAllInstallArgs(
		[{ name: "cerastream", version: "2" }],
		"any",
	);
	expect(
		await runDetachedAptAll(
			args,
			"any",
			{
				onStdout: () => {},
				onStderr: () => {},
				onStatus: (chunk) => {
					status += chunk;
				},
			},
			unit.deps,
		),
	).toBe(0);
	expect(status).toBe(`${dpkgExec}${pm("40.0000")}`);
	expect(unit.cleaned()).toBe(1);
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
	stdout: "Preparing to unpack .../cerastream_2_arm64.deb ...\n",
	stderr: "",
	status: `${dpkgExec}${pm("60.0000")}`,
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
		files: { stdout: "done\n", stderr: "", status: "" },
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
			expect(buildInitialStatus().status.update_state?.kind).toBe("success");
		}
		expect(adopted).toBe(adoptions);
		expect(h.restarts).toBe(restarts);
		// Without a durable record the finished unit is the only evidence: it stays.
		if (failRecord) expect(unit.retired).toEqual([]);
	},
);

test("a launch whose status file could not be made runs the pre-channel command", async () => {
	let lost = 0;
	const unit = fakeUnit({
		files: { stdout: "Unpacking cerastream\n", stderr: "", status: "" },
		exitCode: 0,
		live: true,
	});
	expect(
		await runDetachedAptAll(
			args,
			"any",
			{ ...quiet, onStatusLost: () => lost++ },
			{ ...unit.deps, prepareOutput: async () => ({ status: false }) },
		),
	).toBe(0);
	const command = unit.started[0] ?? [];
	expect(command.join(" ")).not.toContain("Status-Fd");
	expect(command.slice(-3, -1)).toEqual(["/bin/sh", "-ec"]);
	expect(lost).toBe(1);
});

test("a launch never retires a finished unit whose exit nobody recorded", async () => {
	const unit = fakeUnit({
		files: { stdout: "done\n", stderr: "", status: "" },
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
			files.status += pm("90.0000");
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
		"a finished, recorded unit it retires first",
		{ finished: true, recorded: { exitCode: 0 } },
		true,
	],
] as const)(
	"a launch starts past %s only when no unit is left",
	async (_name, o, starts) => {
		const unit = fakeUnit({ files: installing, exitCode: 0, ...o });
		const launched = runDetachedAptAll(args, "any", quiet, unit.deps);
		if (starts) {
			await launched;
			expect(unit.retired[0]).toBe("stop");
			expect(unit.started).toHaveLength(1);
		} else {
			await expect(launched).rejects.toBeInstanceOf(
				DetachedAptServiceAlreadyExistsError,
			);
			expect(unit.cleaned()).toBe(0);
			expect(unit.started).toEqual([]);
		}
	},
);

test.each([
	["always", true, false],
	["twice, then not", 2, true],
] as const)(
	"an outcome record that fails %s keeps the exit, and the unit is retired only once it is recorded",
	async (_name, failRecord, kept) => {
		const unit = fakeUnit({
			files: { stdout: "done\n", stderr: "", status: "" },
			exitCode: 0,
			live: true,
			failRecord,
		});
		expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(0);
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
			status: `${dpkgExec}${pm("60.0000")}pmstatus:cerastream:9`,
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
