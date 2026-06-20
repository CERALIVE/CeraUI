/**
 * Unit tests for async-operation.svelte.ts
 *
 * The bulk drive the rune-free pure core ({@link asyncOpCore}) directly with
 * injected `now` timestamps. The two reconnect cases exercise the reactive layer
 * (runes compile under the svelte vitest plugin); each tears the store down in
 * `afterEach` so no sweep interval leaks across tests.
 */

import { toast } from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ASYNC_OP_TERMINAL_LINGER_MS,
	ASYNC_OP_TTL_MS,
	asyncOpCore,
	beginOperation,
	confirmOperation,
	destroyAsyncOperations,
	getOperationPhase,
	getOperationReason,
	isOperationPending,
	osCommand,
	reconcileOperationsOnReconnect,
} from "./async-operation.svelte";

// osCommand's two feedback collaborators are mocked: `toast` is spied so we can
// assert the SINGLE failure-feedback path, and `getLL()` returns a minimal shape
// so the i18n fallback resolves without booting the typesafe-i18n runtime.
vi.mock("svelte-sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

vi.mock("@ceraui/i18n/svelte", () => ({
	getLL: () => ({
		wifiSelector: { os: { operationFailed: () => "operation_failed" } },
	}),
}));

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

/**
 * Wiring contract for `subscriptions.svelte.ts → handleConnectionChange`, which
 * calls `reconcileOperationsOnReconnect(previous, state)` with the SAME computed
 * `previous`/`state` pair it derives for the seq-tracker reset. These assert the
 * exact call shape that wiring depends on: pending latches drop on the reconnect
 * edge, every other transition leaves them, and settled (terminal) ops are never
 * resurrected by the sweep that the reconnect getStatus hydrate then re-confirms.
 */
describe("async-operation reconnect wiring contract", () => {
	afterEach(() => {
		destroyAsyncOperations();
	});

	it("clears a pending op on a connecting → connected edge", () => {
		beginOperation("reboot");
		expect(isOperationPending("reboot")).toBe(true);
		// handleConnectionChange computes previous="connecting", state="connected".
		reconcileOperationsOnReconnect("connecting", "connected");
		expect(isOperationPending("reboot")).toBe(false);
		expect(getOperationPhase("reboot")).toBe("idle");
	});

	it("drops every pending latch at once on the reconnect edge", () => {
		beginOperation("reboot");
		beginOperation("update");
		beginOperation("ssh");
		reconcileOperationsOnReconnect("disconnected", "connected");
		expect(isOperationPending("reboot")).toBe(false);
		expect(isOperationPending("update")).toBe(false);
		expect(isOperationPending("ssh")).toBe(false);
	});

	it("leaves a settled (confirmed) op untouched across the reconnect edge", () => {
		beginOperation("reboot");
		confirmOperation("reboot");
		expect(getOperationPhase("reboot")).toBe("confirmed");
		reconcileOperationsOnReconnect("disconnected", "connected");
		// Only pending latches drop; a confirmed op keeps its terminal phase so its
		// inline affordance still registers before the sweep decays it.
		expect(getOperationPhase("reboot")).toBe("confirmed");
	});

	it("does not clear a pending op when the edge does not reach connected", () => {
		beginOperation("reboot");
		reconcileOperationsOnReconnect("connected", "disconnected");
		expect(isOperationPending("reboot")).toBe(true);
	});
});

/**
 * osCommand — the single OS-op dispatch + feedback helper. These exercise the
 * reactive store (the public selectors) because osCommand drives it directly;
 * each test tears the store down in `afterEach` so no sweep interval leaks, and
 * the mocked `toast` is cleared between cases so the single-feedback assertions
 * are exact.
 */
describe("osCommand dispatch helper", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		destroyAsyncOperations();
	});

	// 1. fire-and-forget success stays pending (the broadcast/TTL settles it later)
	it("leaves a fire-and-forget op pending on {success:true} and toasts nothing", async () => {
		const result = await osCommand({
			key: "reboot",
			rpc: async () => ({ success: true }),
		});
		expect(result).toEqual({ success: true });
		expect(getOperationPhase("reboot")).toBe("pending");
		expect(toast.error).not.toHaveBeenCalled();
	});

	// 2. confirmOnResolve (synchronous ops only) moves an ok result to confirmed
	it("confirms on resolve when confirmOnResolve is set", async () => {
		await osCommand({
			key: "simPin",
			confirmOnResolve: true,
			rpc: async () => ({ success: true }),
		});
		expect(getOperationPhase("simPin")).toBe("confirmed");
		expect(toast.error).not.toHaveBeenCalled();
	});

	// 3. a thrown rpc fails the op and toasts exactly once
	it("fails and toasts once when the rpc throws", async () => {
		const result = await osCommand({
			key: "update",
			rpc: async () => {
				throw new Error("boom");
			},
		});
		expect(result).toBeUndefined();
		expect(getOperationPhase("update")).toBe("failed");
		expect(getOperationReason("update")).toBe("boom");
		expect(toast.error).toHaveBeenCalledTimes(1);
	});

	// 4. {success:false, error:"DEVICE_BUSY"} → failed + the BUSY thunk (not the fail thunk)
	it("fails with the busy message on a DEVICE_BUSY result", async () => {
		const busyMessage = vi.fn(() => "device_busy_msg");
		const failMessage = vi.fn(() => "fail_msg");
		const result = await osCommand({
			key: "wifi",
			busyMessage,
			failMessage,
			rpc: async () => ({ success: false, error: "DEVICE_BUSY" }),
		});
		expect(result).toEqual({ success: false, error: "DEVICE_BUSY" });
		expect(getOperationPhase("wifi")).toBe("failed");
		expect(getOperationReason("wifi")).toBe("DEVICE_BUSY");
		// Busy path uses the busy thunk and never the fail thunk.
		expect(busyMessage).toHaveBeenCalledTimes(1);
		expect(failMessage).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith("device_busy_msg");
	});

	// 5. re-entry guard: an already-pending key never dispatches a second rpc
	it("no-ops and returns undefined when the key is already pending", async () => {
		beginOperation("reboot");
		expect(isOperationPending("reboot")).toBe(true);
		const rpc = vi.fn(async () => ({ success: true }));
		const result = await osCommand({ key: "reboot", rpc });
		expect(result).toBeUndefined();
		expect(rpc).not.toHaveBeenCalled();
		expect(getOperationPhase("reboot")).toBe("pending");
		expect(toast.error).not.toHaveBeenCalled();
	});

	// 6. onResult receives the raw result on resolve
	it("calls onResult with the raw result on resolve", async () => {
		const onResult = vi.fn();
		const result = { success: true, applied: { ssh: true } };
		await osCommand({ key: "ssh", onResult, rpc: async () => result });
		expect(onResult).toHaveBeenCalledTimes(1);
		expect(onResult).toHaveBeenCalledWith(result);
	});

	// 7. a custom classify overrides the default {success}-shape verdict
	it("uses a custom classify when provided", async () => {
		// The rpc reports a failure shape, but the custom classifier deems it ok —
		// so the op stays pending and no failure toast fires.
		const result = await osCommand({
			key: "scan",
			classify: () => ({ ok: true }),
			rpc: async () => ({ success: false, error: "DEVICE_BUSY" }),
		});
		expect(result).toEqual({ success: false, error: "DEVICE_BUSY" });
		expect(getOperationPhase("scan")).toBe("pending");
		expect(toast.error).not.toHaveBeenCalled();
	});
});
