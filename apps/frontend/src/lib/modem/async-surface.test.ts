/**
 * The bounded-load contract, driven against a fixture that NEVER answers.
 *
 * The whole point of a declared bound is what happens when the device does not
 * reply, so the central table below runs EVERY registered surface against a
 * promise that never settles and asserts each one reaches a terminal state at
 * its own declared bound. A surface added to the registry without a working
 * bound reddens here rather than shipping a spinner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	loadWithinBound,
	MODEM_ASYNC_SURFACES,
	MODEM_READING_STALE_AFTER_MS,
	type ModemAsyncSurfaceId,
	modemBoundMs,
	readingFreshness,
	readingPresence,
	readingStaleDelay,
} from "./async-surface";

const SURFACE_IDS = Object.keys(
	MODEM_ASYNC_SURFACES,
) as readonly ModemAsyncSurfaceId[];

describe("the registry itself", () => {
	it("is not empty, and every entry declares a positive bound", () => {
		expect(SURFACE_IDS.length).toBeGreaterThan(20);
		for (const id of SURFACE_IDS) {
			expect(
				MODEM_ASYNC_SURFACES[id].boundMs,
				`${id} declares no positive bound`,
			).toBeGreaterThan(0);
		}
	});

	it("gives every surface a terminal state, and one of them is the expiry", () => {
		for (const id of SURFACE_IDS) {
			const { terminal } = MODEM_ASYNC_SURFACES[id];
			expect(terminal.length, `${id} names no terminal state`).toBeGreaterThan(
				0,
			);
			// An expiry with no name is an expiry no render site can show, which is
			// the spinner this whole module exists to abolish.
			expect(terminal, `${id} cannot report its own expiry`).toContain(
				"timed-out",
			);
		}
	});

	it("bounds every surface below the transport's own 30 s rejection", () => {
		// A surface bound at or above the client timeout is not a bound the surface
		// owns — it is `client.ts` answering, and the operator meets a generic
		// transport error instead of the surface's own honest terminal.
		for (const id of SURFACE_IDS) {
			expect(
				MODEM_ASYNC_SURFACES[id].boundMs,
				`${id} does not bound the wait before the transport does`,
			).toBeLessThan(30_000);
		}
	});

	it("ages a READING and never a write outcome", () => {
		// A reading can go stale on screen; a write's outcome is a record of an
		// event that happened, and marking that "stale" would be nonsense.
		for (const id of SURFACE_IDS) {
			const entry = MODEM_ASYNC_SURFACES[id];
			if (entry.bound === "read-bound") {
				expect(entry.staleAfterMs, `${id} is a read that cannot age`).toBe(
					MODEM_READING_STALE_AFTER_MS,
				);
			} else {
				expect(
					entry.staleAfterMs,
					`${id} is a write that ages`,
				).toBeUndefined();
			}
		}
	});
});

describe("loadWithinBound — a fixture that never answers", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(SURFACE_IDS)(
		"%s reaches its terminal state at its declared bound",
		async (id) => {
			const boundMs = modemBoundMs(id);
			// A promise with no resolve path at all — the strongest form of "the
			// device never answered".
			const outcome = loadWithinBound(id, () => new Promise<never>(() => {}));

			let settled = false;
			void outcome.then(() => {
				settled = true;
			});

			// One millisecond short of the bound the wait is still live: a bound that
			// fired early would be just as dishonest as one that never fired.
			await vi.advanceTimersByTimeAsync(boundMs - 1);
			expect(settled, `${id} gave up before its declared bound`).toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			await expect(outcome).resolves.toEqual({ phase: "timed-out", boundMs });
		},
	);

	it("clears the armed timer when the call answers first", async () => {
		const clearTimeoutSpy = vi.fn();
		const timers = {
			setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
			clearTimeout: clearTimeoutSpy,
		};

		const outcome = await loadWithinBound(
			"getCapabilities",
			async () => "answered",
			timers,
		);

		expect(outcome).toEqual({ phase: "loaded", value: "answered" });
		// A race that leaves its loser armed holds one timer per dialog open.
		expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
	});

	it("reports a thrown call as `failed`, never as an expiry", async () => {
		const boom = new Error("transport is down");
		const outcome = await loadWithinBound("getBands", async () => {
			throw boom;
		});
		expect(outcome).toEqual({ phase: "failed", error: boom });
	});

	it("absorbs a SYNCHRONOUS throw instead of escaping to the caller", async () => {
		// `rpc.modems.<x>` being undefined throws on the call itself, before any
		// promise exists. The `try/catch` this helper replaced absorbed that; if
		// the helper does not, a partially-mocked surface raises an unhandled
		// rejection where its caller expects a terminal state.
		const boom = new TypeError("rpc.modems.getBands is not a function");
		const outcome = await loadWithinBound("getBands", () => {
			throw boom;
		});
		expect(outcome).toEqual({ phase: "failed", error: boom });
	});

	it("does not adopt an answer that arrives after the bound elapsed", async () => {
		let answer: ((value: string) => void) | undefined;
		const outcome = loadWithinBound(
			"getSms",
			() =>
				new Promise<string>((resolve) => {
					answer = resolve;
				}),
		);

		await vi.advanceTimersByTimeAsync(modemBoundMs("getSms"));
		await expect(outcome).resolves.toMatchObject({ phase: "timed-out" });

		// The operator has already been told the read did not answer. Quietly
		// replacing that with data edits something they read, so the repair is a
		// fresh read rather than a retroactive success.
		answer?.("late");
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(outcome).resolves.toMatchObject({ phase: "timed-out" });
	});

	it("does not raise an unhandled rejection when the losing call fails late", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			let reject: ((error: unknown) => void) | undefined;
			const outcome = loadWithinBound(
				"getGps",
				() =>
					new Promise<never>((_resolve, rejectFn) => {
						reject = rejectFn;
					}),
			);
			await vi.advanceTimersByTimeAsync(modemBoundMs("getGps"));
			await expect(outcome).resolves.toMatchObject({ phase: "timed-out" });

			reject?.(new Error("answered, badly, too late"));
			await vi.advanceTimersByTimeAsync(0);
			await Promise.resolve();
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});
});

describe("readingPresence — absent, empty and zero are three facts", () => {
	it("keeps the tri-state convention the modem surface already documents", () => {
		expect(readingPresence(undefined)).toBe("unloaded");
		expect(readingPresence(null)).toBe("empty");
		expect(readingPresence([])).toBe("empty");
		expect(readingPresence(new Map())).toBe("empty");
		expect(readingPresence(new Set())).toBe("empty");
	});

	it("treats a MEASURED zero as a reading, not as an absence", () => {
		// This is the assertion the whole function exists for: zero bars, zero
		// stored messages and zero bytes are answers the device gave.
		expect(readingPresence(0)).toBe("present");
		expect(readingPresence(false)).toBe("present");
		expect(readingPresence("")).toBe("present");
		expect(readingPresence({})).toBe("present");
	});

	it("separates all three for a collection-shaped reading", () => {
		const facts = [undefined, [], ["one"]].map(readingPresence);
		expect(facts).toEqual(["unloaded", "empty", "present"]);
		expect(new Set(facts).size).toBe(3);
	});
});

describe("readingFreshness — a stale value is never rendered as fresh", () => {
	it("marks a reading that has aged past its window", () => {
		expect(readingFreshness(1_000, 1_000 + 60_000, 60_000)).toBe("stale");
		expect(readingFreshness(1_000, 1_000 + 59_999, 60_000)).toBe("fresh");
	});

	it("answers `unknown` when nothing recorded WHEN the value was read", () => {
		// Withheld rather than guessed, both ways: stamping "Stale" on an unknown
		// age is as much a fabrication as presenting it as current.
		expect(readingFreshness(undefined, 5_000, 60_000)).toBe("unknown");
		expect(readingFreshness(1_000, 5_000, undefined)).toBe("unknown");
	});

	it("arms one deadline and then nothing", () => {
		expect(readingStaleDelay(1_000, 1_000, 60_000)).toBe(60_000);
		expect(readingStaleDelay(1_000, 31_000, 60_000)).toBe(30_000);
		expect(readingStaleDelay(1_000, 61_000, 60_000)).toBeUndefined();
		expect(readingStaleDelay(undefined, 61_000, 60_000)).toBeUndefined();
	});
});
