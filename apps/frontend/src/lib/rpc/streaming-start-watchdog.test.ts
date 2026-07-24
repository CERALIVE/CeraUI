/**
 * Unit tests for streaming-start-watchdog.ts (pure core).
 *
 * Locks the pull/reconcile/revert sequencing the "no more infinite spinner"
 * guarantee depends on (Todo 29 acceptance):
 *
 *   • starting past the contract budget → exactly ONE pull, then
 *     - (pull=true)  reconcile-confirm only, NO revert (lost-success push)
 *     - (pull=false) reconcile (no-op on starting) THEN an explicit revert
 */

import { describe, expect, it, vi } from "vitest";

import {
	runStartWatchdog,
	START_WATCHDOG_REVERT_REASON,
	START_WATCHDOG_TIMEOUT_MS,
	type StartWatchdogDeps,
} from "./streaming-start-watchdog";

interface Recorder {
	deps: StartWatchdogDeps;
	pullCalls: number;
	reconciledWith: boolean[];
	reverts: string[];
}

/** Build injectable deps whose `pullStatus` returns the given queued booleans. */
function makeDeps(pullResults: boolean[]): Recorder {
	const rec: Recorder = {
		pullCalls: 0,
		reconciledWith: [],
		reverts: [],
		deps: undefined as unknown as StartWatchdogDeps,
	};
	rec.deps = {
		pullStatus: async () => {
			const value = pullResults[rec.pullCalls] ?? false;
			rec.pullCalls += 1;
			return value;
		},
		reconcile: (isStreaming) => {
			rec.reconciledWith.push(isStreaming);
		},
		revert: (reason) => {
			rec.reverts.push(reason);
		},
	};
	return rec;
}

describe("streaming-start-watchdog", () => {
	it("exports a sane bounded timeout above the retry budget", () => {
		// Must sit above the 60s bounded-retry budget so a legitimate retry is
		// never cut short.
		expect(START_WATCHDOG_TIMEOUT_MS).toBeGreaterThan(60_000);
	});

	it("pull=true → ONE pull, reconcile(true), NO revert (lost success push recovered)", async () => {
		const rec = makeDeps([true]);
		await runStartWatchdog(rec.deps);

		expect(rec.pullCalls).toBe(1);
		expect(rec.reconciledWith).toEqual([true]);
		expect(rec.reverts).toEqual([]);
	});

	it("pull=false → ONE pull, reconcile(false) THEN an explicit revert (stuck spinner cleared)", async () => {
		const rec = makeDeps([false]);
		await runStartWatchdog(rec.deps);

		expect(rec.pullCalls).toBe(1);
		expect(rec.reconciledWith).toEqual([false]);
		expect(rec.reverts).toEqual([START_WATCHDOG_REVERT_REASON]);
	});

	it("reconcile is called BEFORE revert (authority pulled first)", async () => {
		const order: string[] = [];
		const deps: StartWatchdogDeps = {
			pullStatus: async () => false,
			reconcile: () => order.push("reconcile"),
			revert: () => order.push("revert"),
		};
		await runStartWatchdog(deps);
		expect(order).toEqual(["reconcile", "revert"]);
	});

	it("reverts through the injected path, never a window global", async () => {
		const revert = vi.fn();
		const rec = makeDeps([false]);
		rec.deps.revert = revert;
		await runStartWatchdog(rec.deps);
		expect(revert).toHaveBeenCalledTimes(1);
	});
});
