import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireBackendSingleton } from "../helpers/backend-singleton.ts";

test("startup admits a backend when a bash lookalike names the exact lock and helper paths", async () => {
	// Given a shell blocked on stdin, naming the observer but executing no helper.
	const root = await mkdtemp(join(tmpdir(), "singleton-lookalike-"));
	const paths = {
		lock: join(root, "lock"),
		helper: resolve("../../deployment/ceralive-os-stage-guard"),
	};
	const lookalike = Bun.spawn(
		[
			"/bin/bash",
			"-c",
			"printf 'lookalike-ready\\n'; IFS= read -r ignored",
			paths.lock,
			paths.helper,
			"--orphan-lock",
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	try {
		const reader = lookalike.stdout.getReader();
		await reader.read();
		reader.releaseLock();
		// When legitimate singleton acquisition runs through both real censuses.
		await using _lease = await acquireBackendSingleton(paths);
		// Then the backend owns the lock while the lookalike remains alive.
		expect(lookalike.exitCode).toBeNull();
		const contender = Bun.spawn(
			["/usr/bin/flock", "-n", "-E", "75", "-x", paths.lock, "/usr/bin/true"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		expect(await contender.exited).toBe(75);
	} finally {
		await lookalike.stdin.end();
		await lookalike.exited;
		await rm(root, { recursive: true });
	}
});
