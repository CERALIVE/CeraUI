import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	// When the shared runner expires the child's budget.
	const outcome = await spawnWithTimeout([process.execPath, "-e", termToZero], {
		timeoutMs: 500,
		onExit: (code) => {
			positiveExitSeen = code === 0;
		},
	}).catch((error: unknown) => error);
	// Then a termination-induced zero is a timeout with partial output, not success.
	expect(outcome).toBeInstanceOf(SpawnTimeoutError);
	if (!(outcome instanceof SpawnTimeoutError))
		throw new Error("expected timeout");
	expect(outcome.partialStdout).toBe("partial-output-term-exit-zero");
	expect(positiveExitSeen).toBe(false);
});

test("abort rejects a ready real child even when SIGTERM makes it exit zero", async () => {
	// Given the same live child and an event barrier proving its handler is ready.
	const directory = await mkdtemp(join(tmpdir(), "spawn-abort-"));
	const ready = Promise.withResolvers<void>();
	let positiveExitSeen = false;
	const watcher = watch(directory, () => ready.resolve());
	const controller = new AbortController();
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
		controller.abort();
		await call;
		watcher.close();
		await rm(directory, { recursive: true, force: true });
	}
});
