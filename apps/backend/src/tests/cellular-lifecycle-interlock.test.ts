/**
 * Phase B, T5.5 — LifecycleInterlock primitive: the streaming-admission ↔
 * modem-lifecycle mutual-exclusion gate, tested at the primitive level.
 *
 * Acceptance: BOTH race orders protect the bond (a streaming admission blocks a
 * concurrent USB-mode switch / recovery, and a switch/recovery blocks a concurrent
 * streaming admission); the interlock releases in a `finally` even when the guarded
 * operation THROWS, so it can never deadlock. Real-procedure wiring is covered by
 * `modems-streaming-interlock.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	currentLifecycleHolder,
	isLifecycleHeld,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
	withLifecycleLock,
} from "../modules/streaming/lifecycle-admission.ts";

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("LifecycleInterlock primitive — both race orders + finally-release", () => {
	beforeEach(() => resetLifecycleInterlock());
	afterEach(() => resetLifecycleInterlock());

	test("race order 1: streaming admission in-flight blocks a concurrent modem transition until it releases", async () => {
		const admissionAcquired = deferred<void>();
		const releaseAdmission = deferred<void>();
		const order: string[] = [];

		const streamingOp = (async () => {
			const lease = tryAcquireLifecycle("streaming");
			expect(lease).not.toBeNull();
			order.push("streaming-acquired");
			admissionAcquired.resolve();
			try {
				await releaseAdmission.promise;
			} finally {
				lease?.release();
				order.push("streaming-released");
			}
		})();

		await admissionAcquired.promise;
		expect(tryAcquireLifecycle("modem-transition")).toBeNull();
		expect(currentLifecycleHolder()).toBe("streaming");
		order.push("transition-blocked");

		releaseAdmission.resolve();
		await streamingOp;

		const txLease = tryAcquireLifecycle("modem-transition");
		expect(txLease).not.toBeNull();
		txLease?.release();
		expect(order).toEqual([
			"streaming-acquired",
			"transition-blocked",
			"streaming-released",
		]);
	});

	test("race order 2: modem transition in-flight blocks a concurrent streaming admission until it releases", async () => {
		const transitionAcquired = deferred<void>();
		const releaseTransition = deferred<void>();
		const order: string[] = [];

		const transitionOp = (async () => {
			const lease = tryAcquireLifecycle("modem-transition");
			expect(lease).not.toBeNull();
			order.push("transition-acquired");
			transitionAcquired.resolve();
			try {
				await releaseTransition.promise;
			} finally {
				lease?.release();
				order.push("transition-released");
			}
		})();

		await transitionAcquired.promise;
		expect(tryAcquireLifecycle("streaming")).toBeNull();
		expect(currentLifecycleHolder()).toBe("modem-transition");
		order.push("streaming-blocked");

		releaseTransition.resolve();
		await transitionOp;

		const streamLease = tryAcquireLifecycle("streaming");
		expect(streamLease).not.toBeNull();
		streamLease?.release();
		expect(order).toEqual([
			"transition-acquired",
			"streaming-blocked",
			"transition-released",
		]);
	});

	test("finally-release: a guarded streaming op that THROWS after acquiring still frees the interlock (no deadlock)", async () => {
		let caught: unknown;
		try {
			await withLifecycleLock("streaming", async () => {
				throw new Error("engine start blew up after admission");
			});
		} catch (err) {
			caught = err;
		}

		expect((caught as Error | undefined)?.message).toBe(
			"engine start blew up after admission",
		);
		expect(isLifecycleHeld()).toBe(false);
		const after = tryAcquireLifecycle("modem-transition");
		expect(after).not.toBeNull();
		after?.release();
	});

	test("withLifecycleLock refuses (acquired:false) WITHOUT running fn when the other lifecycle op holds it", async () => {
		const held = tryAcquireLifecycle("streaming");
		expect(held).not.toBeNull();
		let ran = false;
		try {
			const outcome = await withLifecycleLock("modem-transition", async () => {
				ran = true;
				return "should-not-run";
			});
			expect(outcome).toEqual({ acquired: false });
			expect(ran).toBe(false);
		} finally {
			held?.release();
		}
	});

	test("release() is idempotent — a stale double-release never frees a later holder", () => {
		const lease = tryAcquireLifecycle("streaming");
		expect(lease).not.toBeNull();
		lease?.release();
		lease?.release();
		expect(isLifecycleHeld()).toBe(false);

		const other = tryAcquireLifecycle("modem-transition");
		expect(other).not.toBeNull();
		lease?.release();
		expect(currentLifecycleHolder()).toBe("modem-transition");
		other?.release();
	});
});
