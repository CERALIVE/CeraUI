import { expect, spyOn, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import * as policy from "../helpers/spawn-policy.ts";
import { defaultRecoveryProbeIo } from "../modules/system/update-orchestrator/recovery-probes.ts";

test("recovery refuses a TERM-zero child when its command budget expires", async () => {
	// Given a real child with a positively ready TERM handler.
	const root = await mkdtemp(join(tmpdir(), "recovery-term-"));
	const ready = Promise.withResolvers<void>();
	const watcher = watch(root, () => ready.resolve());
	const controller = new AbortController();
	const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
		controller.signal,
	);
	const bounded = policy.spawnWithTimeout;
	let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
	const runner = spyOn(policy, "spawnWithTimeout").mockImplementation(
		(argv, options) =>
			bounded(argv, {
				...options,
				signal: controller.signal,
				scheduleTimeout: () => 0,
				cancelTimeout: () => undefined,
				onSpawn: (spawned) => {
					child = spawned;
				},
			}),
	);
	const watchdog = setTimeout(() => {
		ready.reject(new Error("real child readiness watchdog"));
		child?.kill("SIGKILL");
	}, 10_000);
	const call = defaultRecoveryProbeIo
		.run([
			process.execPath,
			"-e",
			`
		process.on("SIGTERM", () => process.exit(0));
		setInterval(() => {}, 1000);
		await Bun.write(process.argv[1], "ready");
	`,
			join(root, "ready"),
		])
		.catch((error: unknown) => error);
	try {
		await ready.promise;
		// When this runner issues termination, then exit zero is not success.
		controller.abort();
		expect(await call).toBeInstanceOf(policy.SpawnTimeoutError);
	} finally {
		clearTimeout(watchdog);
		controller.abort();
		if (child) {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await child.exited;
		}
		await call;
		runner.mockRestore();
		timeout.mockRestore();
		watcher.close();
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("recovery preserves a genuine nonzero command result", async () => {
	// Given a real failing command, when probing, then preserve its status/output.
	const result = await defaultRecoveryProbeIo.run([
		process.execPath,
		"-e",
		'process.stdout.write("unavailable"); process.stderr.write("diagnostic"); process.exit(7)',
	]);
	expect(result).toEqual({
		code: 7,
		stdout: "unavailable",
		stderr: "diagnostic",
	});
});
