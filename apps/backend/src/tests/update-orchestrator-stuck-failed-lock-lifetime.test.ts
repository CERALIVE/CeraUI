import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { acquirePackageRecoveryLocks } from "../modules/system/update-orchestrator/package-recovery-lock.ts";
import {
	compete,
	lockFixture,
	packageWriterArgv,
	recoverWith,
} from "./helpers/package-recovery-lock-fixture.ts";

for (const boundary of [
	"collector",
	"clear",
	"persist",
	"generation",
	"holder",
] as const) {
	test(`recovery releases and reaps its lock holder after ${boundary} refusal`, async () => {
		// Given a fence that will fail at a specific recovery boundary.
		const f = await lockFixture();
		let holder: Subprocess<"pipe", "pipe", "pipe"> | undefined;
		const fault = () => {
			throw new TypeError("injected recovery refusal");
		};
		const acquisition = () =>
			acquirePackageRecoveryLocks(f.paths, {
				spawn: (argv) => {
					holder = Bun.spawn(argv, {
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					});
					return holder;
				},
			});
		try {
			// When recovery aborts after acquisition instead of publishing idle.
			const recovered = await recoverWith({
				...f.port,
				acquirePackageLocks: acquisition,
				current: () => boundary !== "generation",
				readPackageEvidence: async (locks) => {
					if (boundary === "collector") fault();
					if (boundary === "holder" && holder) {
						holder.kill("SIGKILL");
						await holder.exited;
					}
					return f.port.readPackageEvidence(locks);
				},
				clearPending: async () => {
					if (boundary === "clear") fault();
				},
				persist: boundary === "persist" ? fault : f.port.persist,
			});
			// Then no state is published and no holder or lock is left behind.
			expect({ recovered, effects: f.effects }).toEqual({
				recovered: false,
				effects: [],
			});
			expect(holder).toBeDefined();
			expect(holder?.exitCode !== null || holder?.signalCode !== null).toBe(
				true,
			);
			expect(f.paths.map(compete)).toEqual([0, 0, 0, 0]);
		} finally {
			await f.close();
		}
	});
}

test("holder loss during awaited pending cleanup cannot publish stale consistency", async () => {
	// Given a real holder and clean evidence before the final pending-plan await.
	const f = await lockFixture();
	let holder: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let writer: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	try {
		// When that await loses the holder and a POSIX writer acknowledges ownership.
		const recovered = await recoverWith({
			...f.port,
			acquirePackageLocks: () =>
				acquirePackageRecoveryLocks(f.paths, {
					spawn: (argv) => {
						holder = Bun.spawn(argv, {
							stdin: "pipe",
							stdout: "pipe",
							stderr: "pipe",
						});
						return holder;
					},
				}),
			clearPending: async () => {
				await f.port.clearPending();
				if (!holder) throw new TypeError("missing recovery holder");
				holder.kill("SIGKILL");
				await holder.exited;
				const path = f.paths[0];
				if (!path) throw new TypeError("missing private lock inode");
				writer = Bun.spawn(packageWriterArgv(path, "hold"), {
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					timeout: 5_000,
				});
				const reader = writer.stdout.getReader();
				try {
					expect(new TextDecoder().decode((await reader.read()).value)).toBe(
						"ready\n",
					);
				} finally {
					reader.releaseLock();
				}
			},
		});
		// Then completed cleanup may remain, but neither persistence nor adoption runs.
		expect({ recovered, effects: f.effects }).toEqual({
			recovered: false,
			effects: ["clear"],
		});
	} finally {
		await writer?.stdin.end();
		await writer?.exited;
		await f.close();
	}
});

test("missing lock path refuses readiness and releases already acquired locks", async () => {
	// Given valid predecessors followed by an unavailable lock file.
	const f = await lockFixture();
	try {
		// When the production holder cannot acquire the complete set.
		const operation = acquirePackageRecoveryLocks([
			...f.paths,
			`${f.paths[0]}/missing`,
		]);
		// Then partial acquisition is not a lease and every earlier lock is released.
		await expect(operation).rejects.toThrow("package lock readiness failed");
		expect(f.paths.map(compete)).toEqual([0, 0, 0, 0]);
	} finally {
		await f.close();
	}
});

test("spawn failure stays a refusal before any evidence or settlement", async () => {
	// Given an unavailable holder spawn boundary.
	const f = await lockFixture();
	try {
		// When the fence cannot create its child.
		const recovered = await recoverWith({
			...f.port,
			acquirePackageLocks: () =>
				acquirePackageRecoveryLocks(f.paths, {
					spawn: () => {
						throw new TypeError("injected spawn failure");
					},
				}),
		});
		// Then no old plan or state is changed.
		expect({ recovered, effects: f.effects }).toEqual({
			recovered: false,
			effects: [],
		});
	} finally {
		await f.close();
	}
});

test("readiness timeout kills and awaits an unacknowledged holder", async () => {
	// Given a real child that never acknowledges readiness; no sleeps schedule it.
	const f = await lockFixture();
	let holder: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	try {
		// When the readiness budget expires.
		const operation = acquirePackageRecoveryLocks(f.paths, {
			startupTimeoutMs: 0,
			spawn: () => {
				holder = Bun.spawn(["/bin/bash", "-c", "read -r release"], {
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
				return holder;
			},
		});
		// Then rejection waits for actual child exit rather than leaking the holder.
		await expect(operation).rejects.toThrow("package lock readiness failed");
		expect(holder).toBeDefined();
		expect(holder?.exitCode !== null || holder?.signalCode !== null).toBe(true);
	} finally {
		await f.close();
	}
});

test("backend SIGKILL closes the private pipe and releases the real OFD locks", async () => {
	// Given a disposable backend process holding the production lease.
	const f = await lockFixture();
	const moduleUrl = new URL(
		"../modules/system/update-orchestrator/package-recovery-lock.ts",
		import.meta.url,
	).href;
	const backend = Bun.spawn(
		[
			process.execPath,
			"-e",
			`
const { acquirePackageRecoveryLocks } = await import(${JSON.stringify(moduleUrl)});
await using locks = await acquirePackageRecoveryLocks(${JSON.stringify(f.paths)});
console.log("ready");
await new Response(Bun.stdin.stream()).text();
`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10_000 },
	);
	try {
		const reader = backend.stdout.getReader();
		try {
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(
				"ready\n",
			);
		} finally {
			reader.releaseLock();
		}
		expect(f.paths.map(compete)).toEqual([75, 75, 75, 75]);
		// When the backend dies without executing its finally.
		backend.kill("SIGKILL");
		await backend.exited;
		// Then an independent waiting taker acquires on EOF, without a timed sleep.
		for (const path of f.paths) {
			const taker = Bun.spawn(packageWriterArgv(path, "wait"), {
				stdout: "pipe",
				stderr: "pipe",
				timeout: 3_000,
			});
			expect(await taker.exited).toBe(0);
		}
	} finally {
		await backend.stdin.end();
		if (backend.exitCode === null && backend.signalCode === null)
			backend.kill("SIGKILL");
		await backend.exited;
		await f.close();
	}
});
