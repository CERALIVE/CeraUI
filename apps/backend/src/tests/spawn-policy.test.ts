/*
 * Spawn-policy registry + per-class enforcement (Standard S1).
 *
 * Proves the three load-bearing class contracts with real subprocesses:
 *   (a) bounded-command  → a hung child is killed at its wall-clock timeout.
 *   (b) supervised-worker → a startup/lifetime window does NOT kill a ready
 *                           worker; only shutdown() tears it down.
 *   (c) watcher          → a shutdown-abort kills an intentionally never-ending
 *                           child, and no timeout fires on its own.
 * Plus the registry self-consistency check the exec-guard gate (todo-16) runs.
 */
import { describe, expect, it } from "bun:test";

import {
	type ManagedProcess,
	SPAWN_POLICY,
	SpawnTimeoutError,
	StartupTimeoutError,
	assertSpawnPolicyConsistent,
	getSpawnSite,
	spawnWatcher,
	spawnWithTimeout,
	superviseWorker,
	validateSpawnSite,
} from "../helpers/spawn-policy.ts";

const alive = (proc: ManagedProcess): boolean =>
	proc.exitCode === null && proc.signalCode === null;

describe("spawn-policy registry consistency", () => {
	it("classifies all 15 production spawn sites with unique ids", () => {
		expect(SPAWN_POLICY).toHaveLength(15);
		const ids = new Set(SPAWN_POLICY.map((s) => s.id));
		expect(ids.size).toBe(15);
	});

	it("every site's declared contract satisfies its class invariants", () => {
		for (const site of SPAWN_POLICY) {
			expect(validateSpawnSite(site)).toEqual([]);
		}
		expect(() => assertSpawnPolicyConsistent()).not.toThrow();
	});

	it("cerastream is NOT in the registry (IPC-driven, never spawned)", () => {
		for (const site of SPAWN_POLICY) {
			expect(site.command.toLowerCase()).not.toContain("cerastream");
		}
	});

	it("supervised-workers are exempt from a process-lifetime timeout", () => {
		const workers = SPAWN_POLICY.filter((s) => s.class === "supervised-worker");
		expect(workers.length).toBeGreaterThan(0);
		for (const w of workers) {
			expect(w.contract.timed).toBe(false);
			expect(w.contract.lifetimeTimeoutExempt).toBe(true);
			expect(w.contract.startupTimeout).toBe(true);
			expect(w.contract.shutdownCleanup).toBe(true);
		}
	});

	it("watchers carry no timeout but require a shutdown-abort", () => {
		const watchers = SPAWN_POLICY.filter((s) => s.class === "watcher");
		expect(watchers.length).toBeGreaterThan(0);
		for (const w of watchers) {
			expect(w.contract.timed).toBe(false);
			expect(w.contract.shutdownAbort).toBe(true);
			expect(w.contract.lifetimeTimeoutExempt).toBe(true);
		}
	});

	it("rejects a mis-declared contract (catches a future drift)", () => {
		const srtla = getSpawnSite("streamloop.srtlaSend");
		expect(srtla).toBeDefined();
		if (!srtla) return;
		// A supervised-worker given a lifetime timeout MUST fail validation.
		const drifted = {
			...srtla,
			contract: { ...srtla.contract, timed: true },
		};
		expect(validateSpawnSite(drifted).length).toBeGreaterThan(0);
	});
});

describe("(a) bounded-command enforcement: timeout kills a hung child", () => {
	it("kills a long sleep at the wall-clock budget and rejects", async () => {
		const started = performance.now();
		const call = spawnWithTimeout(["sleep", "30"], { timeoutMs: 150 });
		await expect(call).rejects.toBeInstanceOf(SpawnTimeoutError);
		const elapsed = performance.now() - started;
		// Killed near the budget, FAR below the 30s the child would otherwise run.
		expect(elapsed).toBeLessThan(5_000);
	});

	it("returns output for a child that finishes within budget", async () => {
		const res = await spawnWithTimeout(["bash", "-c", "echo ok"], {
			timeoutMs: 5_000,
		});
		expect(res.exitCode).toBe(0);
		expect(res.stdout.trim()).toBe("ok");
	});
});

describe("(b) supervised-worker enforcement: NOT killed by a lifetime timeout", () => {
	it("a ready worker survives well past any startup window; only shutdown() kills it", async () => {
		const handle = superviseWorker(["sleep", "30"], {
			// Tiny startup window — but readiness resolves immediately, so the
			// startup timer is cleared and NEVER becomes a lifetime kill.
			startupTimeoutMs: 50,
			waitForReady: () => Promise.resolve(),
			killGraceMs: 1_000,
		});

		await handle.ready;

		// Wait far longer than the startup window AND any bounded-command budget.
		await Bun.sleep(400);
		// PROOF: no lifetime timeout exists — the worker is still running.
		expect(alive(handle.proc)).toBe(true);

		// Shutdown cleanup tears it down deterministically.
		await handle.shutdown();
		expect(alive(handle.proc)).toBe(false);
	});

	it("shutdown() is idempotent", async () => {
		const handle = superviseWorker(["sleep", "30"], {
			waitForReady: () => Promise.resolve(),
			killGraceMs: 1_000,
		});
		await handle.ready;
		await handle.shutdown();
		await expect(handle.shutdown()).resolves.toBeUndefined();
		expect(alive(handle.proc)).toBe(false);
	});

	it("a startup-timeout rejects readiness but is distinct from a lifetime kill", async () => {
		const handle = superviseWorker(["sleep", "30"], {
			startupTimeoutMs: 50,
			// Never signals readiness → startup window elapses.
			waitForReady: () => new Promise<void>(() => {}),
			killGraceMs: 1_000,
		});
		await expect(handle.ready).rejects.toBeInstanceOf(StartupTimeoutError);
		// The startup-timeout governs readiness only — it never kills the child.
		expect(alive(handle.proc)).toBe(true);
		await handle.shutdown();
		expect(alive(handle.proc)).toBe(false);
	});
});

describe("(c) watcher enforcement: shutdown-abort kills a never-ending child", () => {
	it("aborting the shutdown signal kills the watcher", async () => {
		const controller = new AbortController();
		const handle = spawnWatcher(["sleep", "30"], {
			signal: controller.signal,
		});

		// No timeout fires on its own — the watcher is intentionally long-lived.
		await Bun.sleep(200);
		expect(alive(handle.proc)).toBe(true);

		controller.abort();
		await handle.proc.exited;
		expect(alive(handle.proc)).toBe(false);
	});

	it("the returned abort() also tears the watcher down (idempotent)", async () => {
		const handle = spawnWatcher(["sleep", "30"]);
		await Bun.sleep(50);
		expect(alive(handle.proc)).toBe(true);
		handle.abort();
		await handle.proc.exited;
		handle.abort();
		expect(alive(handle.proc)).toBe(false);
	});
});
