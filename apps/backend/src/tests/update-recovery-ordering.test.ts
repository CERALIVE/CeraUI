import { expect, test } from "bun:test";
import type { UpdateProgress } from "@ceraui/rpc";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import {
	SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
	softwareUpdateOutputPaths,
} from "../modules/system/software-update-output.ts";
import {
	DetachedAptServiceCleanupError,
	type DetachedAptUpgradeDeps,
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
} from "../modules/system/software-update-process.ts";
import {
	beginSoftwareUpdateRecovery,
	observeSoftwareUpdateWithoutOwning,
	recoverSoftwareUpdateIfRunning,
	type SoftwareUpdateRecoveryDeps,
} from "../modules/system/software-updates.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

const paths = softwareUpdateOutputPaths();
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
}) {
	let state: "running" | "finished" | "absent" = o.live ? "absent" : "running";
	const reads: Record<File, number> = { stdout: 0, stderr: 0, status: 0 };
	const steps = [...(o.steps ?? [])];
	let polls = 0;
	let cleaned = 0;
	let cleanupAttempts = 0;
	const retired: string[] = [];
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: paths,
		prepareOutput: async () => {},
		start: async () => {
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
			else if (state === "running") state = "finished";
		},
	};
	return {
		deps,
		reads,
		retired,
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
				completion = recovered?.completion;
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
	["the status file is unreadable", "status", eio, 0],
	["the status file is unreadable", "status", eio, 100],
	["the status file is missing", "status", enoent, 0],
	["the status file is unreadable", "status", eio, 137],
	["stdout is unreadable", "stdout", eio, 0],
	["stdout is unreadable", "stdout", eio, 100],
	["stdout is unreadable", "stdout", eio, 137],
	["stderr is unreadable", "stderr", eio, 100],
] as const)(
	"when %s, exit %d stays the outcome, the unit is retired and the next update starts",
	async (_name, faulty, error, exitCode) => {
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
		expect(unit.retired).toEqual([retirement]);
		// The same unit name is free again, so the next update can start.
		expect(await runDetachedAptAll(args, "any", quiet, unit.deps)).toBe(
			exitCode,
		);
		expect(unit.retired).toEqual([retirement, retirement]);
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
			deps.completion = recovered?.completion;
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
		await observeSoftwareUpdateWithoutOwning(deps);
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
	await observeSoftwareUpdateWithoutOwning(recoveryOf(unit));
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
	await observeSoftwareUpdateWithoutOwning(deps);
	expect(buildInitialStatus().status).not.toHaveProperty("updating");
	expect(retry).toBeDefined();
	retry?.();
	await h.settled();
	expect(running(h.frames)).toEqual([installingAt(60)]);
	expect(h.frames.at(-1)?.update_state?.kind).toBe("success");
});
