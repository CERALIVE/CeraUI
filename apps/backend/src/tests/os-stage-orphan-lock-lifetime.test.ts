import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { acquireOsOrphanLock } from "../modules/system/update-orchestrator/os-stage-orphan-lock.ts";
import { shippedOsStageGuard } from "./helpers/os-stage-test-guard.ts";

test("readiness refusal explicitly ends the real observer helper stdin", async () => {
	// Given a real helper whose successful readiness is refused by the observer.
	const root = await mkdtemp(join(tmpdir(), "ceraui-orphan-ready-"));
	const supervise = spawnPolicy.superviseWorker;
	let endCalls = () => 0;
	let restoreEnd = () => {};
	let closePipe = async () => {};
	const supervisor = spyOn(spawnPolicy, "superviseWorker").mockImplementation(
		(argv, options) => {
			const handle = supervise(argv, {
				...options,
				waitForReady: async (proc) => {
					await options?.waitForReady?.(proc);
					throw new Error("observer rejected readiness");
				},
			});
			if (
				!("stdin" in handle.proc) ||
				typeof handle.proc.stdin !== "object" ||
				handle.proc.stdin === null ||
				!("end" in handle.proc.stdin) ||
				typeof handle.proc.stdin.end !== "function"
			)
				throw new Error("real helper stdin pipe missing");
			const end = spyOn(handle.proc.stdin, "end");
			const pipe = handle.proc.stdin;
			const endPipe = handle.proc.stdin.end;
			closePipe = async () => {
				await endPipe.call(pipe);
				await new Response(handle.proc.stderr).text();
			};
			endCalls = () => end.mock.calls.length;
			restoreEnd = () => end.mockRestore();
			return handle;
		},
	);
	try {
		// When acquisition unwinds through its readiness-failure shutdown boundary.
		await expect(
			acquireOsOrphanLock({
				lock: join(root, "update.lock"),
				helper: shippedOsStageGuard,
			}),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		// Then EOF was explicit, not dependent on Bun's implicit pipe finalization.
		expect(endCalls()).toBe(1);
	} finally {
		restoreEnd();
		await closePipe();
		supervisor.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});

test("disposing the real observer helper exits and releases its lock promptly", async () => {
	// Given the shipped --orphan-lock mode under a real temporary flock.
	const root = await mkdtemp(join(tmpdir(), "ceraui-orphan-lock-"));
	const lock = join(root, "update.lock");
	try {
		const lease = await acquireOsOrphanLock({
			lock,
			helper: shippedOsStageGuard,
		});
		try {
			expect(lease.held()).toBe(true);
			// When the observer lease is explicitly disposed.
			await lease[Symbol.asyncDispose]();
			// Then the helper has exited and a new writer immediately acquires the lock.
			expect(lease.held()).toBe(false);
			const probe = Bun.spawn(["flock", "-n", "-E", "75", "-x", lock, "true"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await probe.exited).toBe(0);
		} finally {
			if (lease.held()) await lease[Symbol.asyncDispose]();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("closing only the parent pipe releases the real helper lock without disposal", async () => {
	// Given the same shipped helper with an observer-owned stdin pipe.
	const root = await mkdtemp(join(tmpdir(), "ceraui-orphan-eof-"));
	const lock = join(root, "update.lock");
	const child = Bun.spawn(
		[
			"flock",
			"-n",
			"-E",
			"75",
			"-x",
			lock,
			shippedOsStageGuard,
			"--orphan-lock",
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "ignore" },
	);
	try {
		const reader = child.stdout.getReader();
		try {
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(
				"locked\n",
			);
		} finally {
			reader.releaseLock();
		}
		// When parent death is simulated by closing the pipe, with no release message.
		await child.stdin.end();
		// Then EOF exits the helper; no descendant retains the flock.
		expect(await child.exited).toBe(1);
		const probe = Bun.spawn(["flock", "-n", "-E", "75", "-x", lock, "true"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await probe.exited).toBe(0);
	} finally {
		await child.stdin.end();
		await child.exited;
		await rm(root, { recursive: true, force: true });
	}
});
