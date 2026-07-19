/*
 * Regression coverage for the automatic apt-update-check scheduler:
 *
 *   Bug 1 — the first-failures retry used a bare `10` (10ms), hammering apt every
 *           10ms instead of the intended 10 seconds.
 *   Bug 2 — a check skipped while streaming/updating never ran its callback, so
 *           the periodic loop stopped rescheduling and died until backend restart.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { oneHour, oneMinute } from "../helpers/time.ts";
import {
	computeNextCheckDelay,
	periodicCheckForSoftwareUpdates,
	RETRY_DELAY_SHORT_MS,
	resetSoftwareUpdateCheckRunner,
	SKIP_RETRY_DELAY_MS,
	setSoftwareUpdateCheckRunner,
} from "../modules/system/software-updates.ts";

describe("computeNextCheckDelay() — retry backoff", () => {
	const err = new Error("apt-get update failed");

	it("retries after a full 10 SECONDS on the first failures (not 10ms)", () => {
		expect(computeNextCheckDelay(err, 0)).toBe(10_000);
		expect(computeNextCheckDelay(err, 11)).toBe(RETRY_DELAY_SHORT_MS);
		expect(RETRY_DELAY_SHORT_MS).toBe(10_000);
	});

	it("backs off to one minute once failures reach the threshold", () => {
		expect(computeNextCheckDelay(err, 12)).toBe(oneMinute);
		expect(computeNextCheckDelay(err, 99)).toBe(oneMinute);
	});

	it("waits one hour after a successful check (err === null)", () => {
		expect(computeNextCheckDelay(null, 0)).toBe(oneHour);
		expect(computeNextCheckDelay(null, 50)).toBe(oneHour);
	});
});

describe("periodicCheckForSoftwareUpdates() — reschedule after a skip", () => {
	afterEach(() => resetSoftwareUpdateCheckRunner());

	it("still schedules the next check when the current one is skipped", () => {
		// Force the skip path: the runner declines (streaming/updating/apt busy)
		// and, like the real code, never invokes the reschedule callback.
		setSoftwareUpdateCheckRunner(() => false);

		const realSetTimeout = globalThis.setTimeout;
		const scheduledDelays: number[] = [];
		globalThis.setTimeout = ((_fn: () => void, ms?: number) => {
			scheduledDelays.push(ms ?? 0);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof globalThis.setTimeout;

		try {
			periodicCheckForSoftwareUpdates();
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}

		// Pre-fix the skip path scheduled nothing, so this array was empty and the
		// loop was dead until the next backend restart.
		expect(scheduledDelays).toContain(SKIP_RETRY_DELAY_MS);
	});
});
