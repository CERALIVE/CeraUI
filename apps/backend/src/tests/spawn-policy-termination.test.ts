import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
	SpawnTimeoutError,
	spawnWithTimeout,
} from "../helpers/spawn-policy.ts";

const termToZero = `
process.on("SIGTERM", () => {
  process.stdout.write("-term-exit-zero");
  process.exit(0);
});
process.stdout.write("partial-output");
setInterval(() => {}, 1000);
`;

test("timeout rejects a live real child even when SIGTERM makes it exit zero", async () => {
	// Given the reviewer's real Bun child, which succeeds only when terminated.
	let positiveExitSeen = false;
	const directory = await mkdtemp(join(tmpdir(), "spawn-timeout-ready-"));
	const ready = Promise.withResolvers<void>();
	const watcher = watch(directory, () => ready.resolve());
	let fireDeadline: (() => void) | undefined;
	let firstTimer = true;
	const controller = new AbortController();
	let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
	let reaper: ReturnType<typeof setTimeout> | undefined;
	// When the shared runner expires the child's budget.
	const call = spawnWithTimeout(
		[
			process.execPath,
			"-e",
			`${termToZero}\nawait Bun.write(process.argv[1], "ready");`,
			join(directory, "ready"),
		],
		{
			timeoutMs: 500,
			onSpawn: (spawned) => {
				child = spawned;
				reaper = setTimeout(() => {
					ready.reject(new Error("child fixture watchdog"));
					if (spawned.exitCode === null && spawned.signalCode === null)
						spawned.kill("SIGKILL");
				}, 4500);
				reaper.unref();
			},
			signal: controller.signal,
			// Classification clock only; the hard-bound suite retains real escalation.
			scheduleTimeout: (callback) => {
				if (firstTimer) {
					firstTimer = false;
					fireDeadline = callback;
					return 0;
				}
				return 0;
			},
			cancelTimeout: () => undefined,
			onExit: (code) => {
				positiveExitSeen = code === 0;
			},
		},
	).catch((error: unknown) => error);
	try {
		await ready.promise;
		fireDeadline?.();
		const outcome = await call;
		// Then a termination-induced zero is a timeout with partial output, not success.
		expect(outcome).toBeInstanceOf(SpawnTimeoutError);
		if (!(outcome instanceof SpawnTimeoutError))
			throw new Error("expected timeout");
		expect(outcome.partialStdout).toBe("partial-output-term-exit-zero");
		expect(positiveExitSeen).toBe(false);
	} finally {
		if (reaper !== undefined) clearTimeout(reaper);
		controller.abort();
		if (child !== undefined) {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await child.exited;
		}
		await call;
		watcher.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("abort rejects a ready real child even when SIGTERM makes it exit zero", async () => {
	// Given the same live child and an event barrier proving its handler is ready.
	const directory = await mkdtemp(join(tmpdir(), "spawn-abort-"));
	const ready = Promise.withResolvers<void>();
	let positiveExitSeen = false;
	const watcher = watch(directory, () => ready.resolve());
	const controller = new AbortController();
	let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
	let reaper: ReturnType<typeof setTimeout> | undefined;
	const call = spawnWithTimeout(
		[
			process.execPath,
			"-e",
			`${termToZero}\nawait Bun.write(process.argv[1], "ready");`,
			join(directory, "ready"),
		],
		{
			signal: controller.signal,
			timeoutMs: 5000,
			scheduleTimeout: () => 0,
			cancelTimeout: () => undefined,
			onSpawn: (spawned) => {
				child = spawned;
				reaper = setTimeout(() => {
					ready.reject(new Error("child fixture watchdog"));
					if (spawned.exitCode === null && spawned.signalCode === null)
						spawned.kill("SIGKILL");
				}, 4500);
				reaper.unref();
			},
			onExit: (code) => {
				positiveExitSeen = code === 0;
			},
		},
	).catch((error: unknown) => error);
	try {
		await ready.promise;
		// When cancellation terminates the still-running child.
		controller.abort();
		const outcome = await call;
		// Then its zero exit cannot turn abort into a successful command.
		expect(outcome).toBeInstanceOf(SpawnTimeoutError);
		if (!(outcome instanceof SpawnTimeoutError))
			throw new Error("expected abort");
		expect(outcome.partialStdout).toBe("partial-output-term-exit-zero");
		expect(positiveExitSeen).toBe(false);
	} finally {
		if (reaper !== undefined) clearTimeout(reaper);
		controller.abort();
		if (child !== undefined) {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await child.exited;
		}
		await call;
		watcher.close();
		await rm(directory, { recursive: true, force: true });
	}
});
