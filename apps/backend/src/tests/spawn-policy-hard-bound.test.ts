import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
	BOUNDED_SPAWN_DRAIN_MS,
	BOUNDED_SPAWN_REAP_MS,
	BOUNDED_SPAWN_TERM_GRACE_MS,
	collectBoundedChild,
} from "../helpers/bounded-spawn.ts";
import {
	SpawnTimeoutError,
	spawnWithTimeout,
} from "../helpers/spawn-policy.ts";
import { createManualSpawnClock } from "./helpers/manual-spawn-clock.ts";

test("a non-exiting child is rejected after exactly TERM grace, KILL reap and drain bounds", async () => {
	// Given a child and open pipes that never settle on their own.
	const clock = createManualSpawnClock();
	const exit = Promise.withResolvers<number>();
	const teardown = Promise.withResolvers<void>();
	const openPipe = () => {
		let cancelled = false;
		return new ReadableStream<Uint8Array<ArrayBuffer>>({
			start(controller) {
				void teardown.promise.then(() => {
					if (!cancelled) controller.close();
				});
			},
			cancel() {
				cancelled = true;
			},
		});
	};
	const output = openPipe();
	const errors = openPipe();
	const signals: (number | NodeJS.Signals | undefined)[] = [];
	const unused = () => {
		throw new Error("unused subprocess operation");
	};
	const child = {
		stdin: undefined,
		stdout: output,
		stderr: errors,
		readable: output,
		terminal: undefined,
		stdio: [null, null, null],
		pid: 1,
		exited: exit.promise,
		exitCode: null,
		signalCode: null,
		killed: false,
		kill: (signal?: number | NodeJS.Signals) => {
			signals.push(signal ?? "SIGTERM");
		},
		ref: unused,
		unref: unused,
		send: unused,
		disconnect: unused,
		resourceUsage: unused,
		[Symbol.asyncDispose]: unused,
	} satisfies Subprocess<"ignore", "pipe", "pipe">;
	let settled = false;
	const call = collectBoundedChild(child, "non-exiting", {
		timeoutMs: 150,
		...clock,
	})
		.catch((error: unknown) => error)
		.then((outcome: unknown) => {
			settled = true;
			return outcome;
		});
	try {
		// When each requested timer, and no exit or drain event, advances the runner.
		expect(clock.delays).toEqual([150]);
		await clock.fireNext();
		expect(signals).toEqual(["SIGTERM"]);
		expect(settled).toBe(false);
		expect(clock.pendingDelay).toBe(BOUNDED_SPAWN_TERM_GRACE_MS);
		await clock.fireNext();
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(settled).toBe(false);
		expect(clock.pendingDelay).toBe(BOUNDED_SPAWN_REAP_MS);
		await clock.fireNext();
		expect(settled).toBe(false);
		expect(clock.pendingDelay).toBe(BOUNDED_SPAWN_DRAIN_MS);
		await clock.fireNext();
		// Then rejection has no unbounded exit/drain dependency and requests 100/100/50.
		expect(settled).toBe(true);
		expect(clock.delays).toEqual([150, 100, 100, 50]);
		expect(await call).toBeInstanceOf(SpawnTimeoutError);
	} finally {
		exit.resolve(137);
		teardown.resolve();
		await clock.flush();
		while (clock.pendingDelay !== undefined) await clock.fireNext();
		await call;
	}
});

test("a ready TERM-ignoring real child is SIGKILLed and reaped after bounded rejection", async () => {
	// Given a ready child that cannot retire itself before escalation.
	const directory = await mkdtemp(join(tmpdir(), "spawn-hard-bound-"));
	const ready = Promise.withResolvers<void>();
	const watcher = watch(directory, () => ready.resolve());
	const controller = new AbortController();
	const clock = createManualSpawnClock();
	let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
	let safetyTimer: ReturnType<typeof setTimeout> | undefined;
	// Ten seconds detects a stuck fixture/reaper; it is not a retirement-latency claim.
	const safety = new Promise<never>((_resolve, reject) => {
		safetyTimer = setTimeout(
			() => reject(new Error("real child retirement safety deadline")),
			10_000,
		);
	});
	void safety.catch(() => undefined);
	const call = spawnWithTimeout(
		[
			process.execPath,
			"-e",
			`process.on("SIGTERM", () => {}); process.stdout.write(String(process.pid)); await Bun.write(process.argv[1], "ready"); setInterval(() => {}, 1000);`,
			join(directory, "ready"),
		],
		{
			...clock,
			signal: controller.signal,
			timeoutMs: 150,
			onSpawn: (spawned) => {
				child = spawned;
			},
		},
	).catch((error: unknown) => error);
	try {
		await Promise.race([ready.promise, safety]);
		// When cancellation meets a handler that ignores TERM.
		await clock.fireNext();
		while (clock.pendingDelay !== undefined) await clock.fireNext();
		const outcome = await Promise.race([call, safety]);
		// Then the hard cleanup bound rejects and the actual child is reaped.
		expect(outcome).toBeInstanceOf(SpawnTimeoutError);
		if (!(outcome instanceof SpawnTimeoutError))
			throw new Error("expected timeout");
		if (child === undefined) throw new Error("missing real child handle");
		await Promise.race([child.exited, safety]);
		expect(child.signalCode).toBe("SIGKILL");
		await expect(
			readFile(`/proc/${child.pid}/stat`, "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		if (safetyTimer !== undefined) clearTimeout(safetyTimer);
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
}, 30_000);

test("positive parent exit cannot leave the runner draining inherited pipes past deadline", async () => {
	// Given a zero-exit parent with output held open by its test-owned descendant.
	let positive = false;
	const exited = Promise.withResolvers<void>();
	const clock = createManualSpawnClock();
	const directory = await mkdtemp(join(tmpdir(), "spawn-inherited-pipe-"));
	let parent: Subprocess<"ignore", "pipe", "pipe"> | undefined;
	let inheritedPid = 0;
	let safetyTimer: ReturnType<typeof setTimeout> | undefined;
	const safety = new Promise<never>((_resolve, reject) => {
		safetyTimer = setTimeout(
			() => reject(new Error("positive exit fixture safety deadline")),
			10_000,
		);
	});
	void safety.catch(() => undefined);
	// When the real zero exit precedes the injected deadline, regardless of startup scheduling.
	const call = spawnWithTimeout(
		[
			"bash",
			"-c",
			'printf ready; sleep infinity & printf %s "$!" > "$1"; exit 0',
			"fixture",
			join(directory, "pid"),
		],
		{
			...clock,
			timeoutMs: 30,
			onSpawn: (child) => {
				parent = child;
			},
			onExit: (code) => {
				positive = code === 0;
				exited.resolve();
			},
		},
	);
	try {
		await Promise.race([exited.promise, safety]);
		inheritedPid = Number(await readFile(join(directory, "pid"), "utf8"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await clock.fireNext();
		while (clock.pendingDelay !== undefined) await clock.fireNext();
		const result = await Promise.race([call, safety]);
		// Then genuine success survives a deadline with permanently inherited-open output.
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("ready");
		expect(positive).toBe(true);
		expect(clock.delays).toEqual([30, BOUNDED_SPAWN_DRAIN_MS]);
	} finally {
		if (safetyTimer !== undefined) clearTimeout(safetyTimer);
		if (inheritedPid === 0 && (await Bun.file(join(directory, "pid")).exists()))
			inheritedPid = Number(await readFile(join(directory, "pid"), "utf8"));
		if (Number.isInteger(inheritedPid) && inheritedPid > 0)
			process.kill(inheritedPid, "SIGKILL");
		if (parent !== undefined) {
			if (parent.exitCode === null && parent.signalCode === null)
				parent.kill("SIGKILL");
			await parent.exited;
		}
		while (clock.pendingDelay !== undefined) await clock.fireNext();
		await call;
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
