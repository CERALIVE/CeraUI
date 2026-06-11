import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";

// Edge-case hardening for the BCRPT retry/backoff (modules/streaming/bcrpt.ts).
//
// BCRPT config generation can fail transiently on a streaming device (no relay
// config yet, a filesystem hiccup). Two invariants keep that from turning into a
// hot loop or an infinite restart storm:
//
//   1. it retries with EXPONENTIAL backoff (each delay double the previous), and
//   2. it gives up after exactly MAX_BCRPT_RETRIES attempts.
//
// The retry counter and backoff math are module-private, so we drive the real
// startBcrpt() through its failure path (writeTextFile forced to reject) and
// observe the scheduling via a captured setTimeout. We manually pump each
// scheduled retry so the whole sequence runs synchronously and deterministically
// — no real timers, no real BCRPT binary.

import * as textFiles from "../../helpers/text-files.ts";
import {
	INITIAL_RETRY_DELAY,
	MAX_BCRPT_RETRIES,
} from "../../helpers/timing-constants.ts";
import { setup } from "../../modules/setup.ts";
import { startBcrpt } from "../../modules/streaming/bcrpt.ts";

// Delays passed to setTimeout across the entire driven retry sequence.
const observedDelays: number[] = [];
// True once a further retry was attempted after the cap was reached (regression
// signal: the cap leaked an extra scheduled retry).
let scheduledAfterGiveUp = false;

beforeAll(async () => {
	// startBcrpt() mkdir()s its working dir before the failure path; make sure it
	// exists so the retry path (not an unrelated mkdir error) is what we exercise.
	const bcrptDir = setup.bcrpt_path ?? "/var/run/bcrpt";
	try {
		fs.mkdirSync(bcrptDir, { recursive: true });
	} catch {
		// best-effort: on a box where the dir already exists / is unwritable the
		// real mkdir in startBcrpt has the same outcome we'd get here.
	}

	// Force every config-write to reject so startBcrpt always takes the retry
	// branch. writeTextFile normally swallows errors, so we replace it wholesale.
	const wtSpy = spyOn(textFiles, "writeTextFile").mockRejectedValue(
		new Error("forced config-generation failure"),
	);

	const originalSetTimeout = globalThis.setTimeout;
	let pending: (() => void) | undefined;
	let givenUp = false;
	globalThis.setTimeout = ((fn: () => void, delay?: number) => {
		if (typeof delay === "number") observedDelays.push(delay);
		if (givenUp) scheduledAfterGiveUp = true;
		pending = fn;
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof globalThis.setTimeout;

	try {
		await startBcrpt();
		// Pump scheduled retries one at a time. Bound the loop well past
		// MAX_BCRPT_RETRIES so a regressed cap (infinite retry) terminates the test
		// instead of hanging — and is caught by the scheduledAfterGiveUp guard.
		const HARD_CAP = MAX_BCRPT_RETRIES + 5;
		for (let i = 0; i < HARD_CAP && pending; i++) {
			const next = pending;
			pending = undefined;
			// After we've pumped MAX_BCRPT_RETRIES retries, the next invocation is
			// the one that must hit "give up" and schedule nothing further.
			if (observedDelays.length >= MAX_BCRPT_RETRIES) givenUp = true;
			await next();
		}
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		wtSpy.mockRestore();
	}
});

describe("bcrpt retry: max-attempts boundary", () => {
	test("retries exactly MAX_BCRPT_RETRIES times, then gives up", () => {
		// One backoff timer is armed per failed attempt; the give-up branch arms
		// none. So the number of scheduled delays equals the retry cap exactly.
		expect(observedDelays.length).toBe(MAX_BCRPT_RETRIES);
		// And no retry was scheduled after the cap was reached.
		expect(scheduledAfterGiveUp).toBe(false);
	});
});

describe("bcrpt retry: exponential backoff", () => {
	test("each retry delay is INITIAL_RETRY_DELAY * 2^n and strictly grows", () => {
		// Exact exponential schedule: 1000, 2000, 4000, 8000, 16000 (for MAX=5).
		const expected = Array.from(
			{ length: MAX_BCRPT_RETRIES },
			(_unused, n) => INITIAL_RETRY_DELAY * 2 ** n,
		);
		expect(observedDelays).toEqual(expected);

		// Strict growth: every delay is larger than the one before it.
		for (let i = 1; i < observedDelays.length; i++) {
			const prev = observedDelays[i - 1] ?? 0;
			const cur = observedDelays[i] ?? 0;
			expect(cur).toBeGreaterThan(prev);
		}
	});
});
