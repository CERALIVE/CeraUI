import { expect, test } from "bun:test";
import type { UpdateProgress } from "@ceraui/rpc";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import {
	SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
	softwareUpdateOutputPaths,
} from "../modules/system/software-update-output.ts";
import {
	type DetachedAptUpgradeDeps,
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
} from "../modules/system/software-update-process.ts";
import {
	beginSoftwareUpdateRecovery,
	recoverSoftwareUpdateIfRunning,
	settleSoftwareUpdateRecoveryIfAbsent,
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
}) {
	let state: "running" | "finished" | "absent" = o.live ? "absent" : "running";
	const reads: Record<File, number> = { stdout: 0, stderr: 0, status: 0 };
	const steps = [...(o.steps ?? [])];
	let polls = 0;
	let cleaned = 0;
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
		cleanup: async () => {
			cleaned++;
			state = "absent";
		},
		readOutput: async (path, offset) => {
			const file: File =
				path === paths.stdout
					? "stdout"
					: path === paths.stderr
						? "stderr"
						: "status";
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
	return { deps, reads, cleaned: () => cleaned };
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

test.each([
	["unreadable, apt succeeded", 0, () => new Error("EIO")],
	["unreadable, apt failed", 100, () => new Error("EIO")],
	["missing, apt succeeded", 0, enoent],
])(
	"a status file that is %s never changes the outcome or strands the unit",
	async (_name, exitCode, error) => {
		const unit = fakeUnit({
			files: { stdout: "done\n", stderr: "", status: "" },
			exitCode,
			failRead: (file) => (file === "status" ? error() : undefined),
			live: true,
		});
		const args = buildAptAllInstallArgs(
			[{ name: "cerastream", version: "2" }],
			"any",
		);
		const handlers = { onStdout: () => {}, onStderr: () => {} };
		expect(
			await runDetachedAptAll(
				args,
				"any",
				{ ...handlers, onStatus: () => {} },
				unit.deps,
			),
		).toBe(exitCode);
		expect(unit.cleaned()).toBe(1);
		// The unit is gone, so the next update can start.
		const next = fakeUnit({
			files: { stdout: "", stderr: "", status: "" },
			exitCode: 0,
			live: true,
		});
		expect(await runDetachedAptAll(args, "any", handlers, next.deps)).toBe(0);
	},
);

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

test.each([
	["running", false],
	["absent", true],
] as const)(
	"after a refused bootstrap, a %s unit decides whether the tab hears null",
	async (kind, cleared) => {
		await using h = await updateHarness();
		beginSoftwareUpdateRecovery();
		await settleSoftwareUpdateRecoveryIfAbsent(async () =>
			kind === "absent" ? { kind: "absent" } : { kind: "running" },
		);
		const status = buildInitialStatus().status;
		if (cleared) {
			expect(status).toHaveProperty("updating", null);
			expect(h.frames.at(-1)?.updating).toBeNull();
		} else {
			expect(status).not.toHaveProperty("updating");
			expect(h.frames.some((frame) => frame.updating !== undefined)).toBe(
				false,
			);
		}
	},
);
