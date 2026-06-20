/**
 * Unit tests for async-operation.svelte.ts
 *
 * The bulk drive the rune-free pure core ({@link asyncOpCore}) directly with
 * injected `now` timestamps. The two reconnect cases exercise the reactive layer
 * (runes compile under the svelte vitest plugin); each tears the store down in
 * `afterEach` so no sweep interval leaks across tests.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	ASYNC_OP_TERMINAL_LINGER_MS,
	ASYNC_OP_TTL_MS,
	asyncOpCore,
	beginOperation,
	destroyAsyncOperations,
	isOperationPending,
	reconcileOperationsOnReconnect,
} from "./async-operation.svelte";

const {
	createRegistry,
	getPhase,
	getReason,
	isPending,
	begin,
	confirm,
	fail,
	timeout,
	clear,
	sweep,
} = asyncOpCore;

describe("async-operation pure core", () => {
	describe("createRegistry", () => {
		it("creates an empty registry", () => {
			const reg = createRegistry();
			expect(reg.ops).toEqual({});
		});

		it("treats an absent key as idle", () => {
			const reg = createRegistry();
			expect(getPhase(reg, "reboot")).toBe("idle");
			expect(getReason(reg, "reboot")).toBeUndefined();
		});
	});

	// 1. begin → confirm yields confirmed
	describe("begin → confirm", () => {
		it("yields confirmed", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			expect(getPhase(reg, "reboot")).toBe("pending");
			expect(confirm(reg, "reboot", 10)).toBe(true);
			expect(getPhase(reg, "reboot")).toBe("confirmed");
		});
	});

	// 2. begin → fail("x") yields failed with reason
	describe("begin → fail", () => {
		it("yields failed with the reason", () => {
			const reg = createRegistry();
			begin(reg, "update", undefined, 0);
			expect(fail(reg, "update", "DEVICE_BUSY", 10)).toBe(true);
			expect(getPhase(reg, "update")).toBe("failed");
			expect(getReason(reg, "update")).toBe("DEVICE_BUSY");
		});
	});

	// 3. begin + sweep past TTL yields timed_out (NOT deleted)
	describe("begin + sweep past TTL", () => {
		it("flips a stale pending to timed_out without deleting it", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			const changed = sweep(reg, ASYNC_OP_TTL_MS + 1);
			expect(changed).toEqual(["reboot"]);
			// Entry still exists, now timed_out — surface can show "still working / Retry".
			expect(reg.ops.reboot).toBeDefined();
			expect(getPhase(reg, "reboot")).toBe("timed_out");
		});
	});

	// 4. terminal phases decay to idle after ASYNC_OP_TERMINAL_LINGER_MS (entry deleted)
	describe("terminal decay", () => {
		it("deletes a confirmed op past the linger window", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			confirm(reg, "reboot", 0);
			const changed = sweep(reg, ASYNC_OP_TERMINAL_LINGER_MS + 1);
			expect(changed).toEqual(["reboot"]);
			expect(reg.ops.reboot).toBeUndefined();
			expect(getPhase(reg, "reboot")).toBe("idle");
		});

		it("deletes a failed op past the linger window", () => {
			const reg = createRegistry();
			begin(reg, "update", undefined, 0);
			fail(reg, "update", "boom", 0);
			sweep(reg, ASYNC_OP_TERMINAL_LINGER_MS + 1);
			expect(getPhase(reg, "update")).toBe("idle");
		});

		it("deletes a timed_out op past the linger window", () => {
			const reg = createRegistry();
			begin(reg, "ssh", undefined, 0);
			timeout(reg, "ssh", 0);
			sweep(reg, ASYNC_OP_TERMINAL_LINGER_MS + 1);
			expect(getPhase(reg, "ssh")).toBe("idle");
		});

		it("keeps a terminal op inside the linger window", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			confirm(reg, "reboot", 0);
			const changed = sweep(reg, ASYNC_OP_TERMINAL_LINGER_MS - 1);
			expect(changed).toEqual([]);
			expect(getPhase(reg, "reboot")).toBe("confirmed");
		});
	});

	// 5. confirm/fail/timeout from idle are no-ops (return false)
	describe("transitions from idle are no-ops", () => {
		it("confirm on an absent key returns false", () => {
			const reg = createRegistry();
			expect(confirm(reg, "reboot", 0)).toBe(false);
			expect(getPhase(reg, "reboot")).toBe("idle");
		});

		it("fail on an absent key returns false", () => {
			const reg = createRegistry();
			expect(fail(reg, "reboot", "x", 0)).toBe(false);
			expect(getPhase(reg, "reboot")).toBe("idle");
		});

		it("timeout on an absent key returns false", () => {
			const reg = createRegistry();
			expect(timeout(reg, "reboot", 0)).toBe(false);
			expect(getPhase(reg, "reboot")).toBe("idle");
		});

		it("cannot transition from a terminal phase (only pending → X)", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			confirm(reg, "reboot", 0);
			expect(confirm(reg, "reboot", 1)).toBe(false);
			expect(fail(reg, "reboot", "x", 1)).toBe(false);
			expect(timeout(reg, "reboot", 1)).toBe(false);
			expect(getPhase(reg, "reboot")).toBe("confirmed");
		});
	});

	// 6. isPending is true only during pending
	describe("isPending", () => {
		it("is true only while pending", () => {
			const reg = createRegistry();
			expect(isPending(reg, "reboot")).toBe(false);
			begin(reg, "reboot", undefined, 0);
			expect(isPending(reg, "reboot")).toBe(true);
			confirm(reg, "reboot", 1);
			expect(isPending(reg, "reboot")).toBe(false);

			begin(reg, "update", undefined, 0);
			fail(reg, "update", "x", 1);
			expect(isPending(reg, "update")).toBe(false);

			begin(reg, "ssh", undefined, 0);
			timeout(reg, "ssh", 1);
			expect(isPending(reg, "ssh")).toBe(false);
		});
	});

	// 9. sweep flips a stale pending to timed_out exactly ONCE
	describe("sweep idempotence on a stale pending", () => {
		it("flips to timed_out once; a second sweep does not re-emit it", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			const first = sweep(reg, ASYNC_OP_TTL_MS + 1);
			expect(first).toEqual(["reboot"]);
			expect(getPhase(reg, "reboot")).toBe("timed_out");

			// A second sweep at the same instant: the op is now timed_out (terminal)
			// but still inside the linger window, so nothing is re-emitted.
			const second = sweep(reg, ASYNC_OP_TTL_MS + 1);
			expect(second).toEqual([]);
			expect(getPhase(reg, "reboot")).toBe("timed_out");
		});
	});

	// 10. begin from any phase re-arms (overwriting is allowed)
	describe("begin re-arms from any phase", () => {
		it("re-arms a confirmed op back to pending", () => {
			const reg = createRegistry();
			begin(reg, "reboot", "a", 0);
			confirm(reg, "reboot", 1);
			expect(getPhase(reg, "reboot")).toBe("confirmed");

			expect(begin(reg, "reboot", "b", 2)).toBe(true);
			expect(getPhase(reg, "reboot")).toBe("pending");
			expect(reg.ops.reboot?.target).toBe("b");
			expect(reg.ops.reboot?.reason).toBeUndefined();
		});

		it("re-arms a timed_out op back to pending (Retry)", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			sweep(reg, ASYNC_OP_TTL_MS + 1);
			expect(getPhase(reg, "reboot")).toBe("timed_out");
			begin(reg, "reboot", undefined, ASYNC_OP_TTL_MS + 2);
			expect(getPhase(reg, "reboot")).toBe("pending");
		});

		it("re-arms a stale pending and resets its TTL", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			// Re-begin at the TTL edge resets ts, so the next sweep at the same
			// instant must NOT time it out.
			begin(reg, "reboot", undefined, ASYNC_OP_TTL_MS);
			const changed = sweep(reg, ASYNC_OP_TTL_MS + 1);
			expect(changed).toEqual([]);
			expect(getPhase(reg, "reboot")).toBe("pending");
		});
	});

	describe("clear", () => {
		it("deletes an entry back to idle", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			clear(reg, "reboot");
			expect(getPhase(reg, "reboot")).toBe("idle");
		});

		it("is a no-op on an absent key", () => {
			const reg = createRegistry();
			expect(() => clear(reg, "reboot")).not.toThrow();
		});
	});

	describe("sweep leaves a fresh pending untouched", () => {
		it("does not time out a pending op inside its TTL", () => {
			const reg = createRegistry();
			begin(reg, "reboot", undefined, 0);
			const changed = sweep(reg, ASYNC_OP_TTL_MS - 1);
			expect(changed).toEqual([]);
			expect(getPhase(reg, "reboot")).toBe("pending");
		});
	});
});

describe("async-operation reactive reconnect reconciliation", () => {
	afterEach(() => {
		destroyAsyncOperations();
	});

	// 7. reconcileOperationsOnReconnect("disconnected","connected") clears a pending key
	it("clears a pending key on the reconnect edge", () => {
		beginOperation("reboot");
		expect(isOperationPending("reboot")).toBe(true);
		reconcileOperationsOnReconnect("disconnected", "connected");
		expect(isOperationPending("reboot")).toBe(false);
	});

	// 8. reconcileOperationsOnReconnect("connected","connected") does NOT clear a pending key
	it("does not clear a pending key on a steady connected tick", () => {
		beginOperation("reboot");
		expect(isOperationPending("reboot")).toBe(true);
		reconcileOperationsOnReconnect("connected", "connected");
		expect(isOperationPending("reboot")).toBe(true);
	});
});
