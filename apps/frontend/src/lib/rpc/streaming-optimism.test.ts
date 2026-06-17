/**
 * Unit tests for streaming-optimism.svelte.ts
 *
 * Tests the pure core functions (rune-free) for optimistic state transitions,
 * reconciliation to authoritative broadcast, and failure revert with reason.
 */

import { describe, expect, it } from "vitest";
import {
	clearStopReason,
	createOptimismStore,
	reconcileToAuthority,
	revertWithReason,
	type StreamingOptimismStore,
	transitionToStarting,
	transitionToStopping,
} from "./streaming-optimism.svelte";

describe("streaming-optimism", () => {
	describe("createOptimismStore", () => {
		it("creates an idle store with no stop reason", () => {
			const store = createOptimismStore();
			expect(store.state).toBe("idle");
			expect(store.stopReason).toBeUndefined();
		});
	});

	describe("transitionToStarting", () => {
		it("transitions from idle to starting", () => {
			const store = createOptimismStore();
			const next = transitionToStarting(store);
			expect(next.state).toBe("starting");
			expect(next.stopReason).toBeUndefined();
		});

		it("clears stop reason when transitioning to starting", () => {
			const store: StreamingOptimismStore = {
				state: "idle",
				stopReason: "engine_error",
			};
			const next = transitionToStarting(store);
			expect(next.state).toBe("starting");
			expect(next.stopReason).toBeUndefined();
		});

		it("does not mutate the original store", () => {
			const store = createOptimismStore();
			const next = transitionToStarting(store);
			expect(store.state).toBe("idle");
			expect(next.state).toBe("starting");
		});
	});

	describe("transitionToStopping", () => {
		it("transitions from idle to stopping", () => {
			const store = createOptimismStore();
			const next = transitionToStopping(store);
			expect(next.state).toBe("stopping");
			expect(next.stopReason).toBeUndefined();
		});

		it("clears stop reason when transitioning to stopping", () => {
			const store: StreamingOptimismStore = {
				state: "idle",
				stopReason: "user_stop",
			};
			const next = transitionToStopping(store);
			expect(next.state).toBe("stopping");
			expect(next.stopReason).toBeUndefined();
		});
	});

	describe("reconcileToAuthority", () => {
		it("reconciles starting to idle when is_streaming becomes true", () => {
			const store: StreamingOptimismStore = { state: "starting" };
			const next = reconcileToAuthority(store, true);
			expect(next.state).toBe("idle");
			expect(next.stopReason).toBeUndefined();
		});

		it("reconciles stopping to idle when is_streaming becomes false", () => {
			const store: StreamingOptimismStore = { state: "stopping" };
			const next = reconcileToAuthority(store, false);
			expect(next.state).toBe("idle");
			expect(next.stopReason).toBeUndefined();
		});

		it("reconciles starting to idle when is_streaming is false (start failed)", () => {
			const store: StreamingOptimismStore = { state: "starting" };
			const next = reconcileToAuthority(store, false);
			expect(next.state).toBe("idle");
		});

		it("reconciles stopping to idle when is_streaming is true (stop failed)", () => {
			const store: StreamingOptimismStore = { state: "stopping" };
			const next = reconcileToAuthority(store, true);
			expect(next.state).toBe("idle");
		});

		it("is idempotent when already at truth", () => {
			const store: StreamingOptimismStore = { state: "idle" };
			const next = reconcileToAuthority(store, false);
			expect(next.state).toBe("idle");
		});

		it("clears stop reason on reconcile", () => {
			const store: StreamingOptimismStore = {
				state: "starting",
				stopReason: "old_error",
			};
			const next = reconcileToAuthority(store, true);
			expect(next.stopReason).toBeUndefined();
		});
	});

	describe("revertWithReason", () => {
		it("reverts starting to idle with a reason", () => {
			const store: StreamingOptimismStore = { state: "starting" };
			const next = revertWithReason(store, "engine_error");
			expect(next.state).toBe("idle");
			expect(next.stopReason).toBe("engine_error");
		});

		it("reverts stopping to idle with a reason", () => {
			const store: StreamingOptimismStore = { state: "stopping" };
			const next = revertWithReason(store, "stop_failed");
			expect(next.state).toBe("idle");
			expect(next.stopReason).toBe("stop_failed");
		});

		it("overwrites an existing stop reason", () => {
			const store: StreamingOptimismStore = {
				state: "idle",
				stopReason: "old_reason",
			};
			const next = revertWithReason(store, "new_reason");
			expect(next.stopReason).toBe("new_reason");
		});
	});

	describe("clearStopReason", () => {
		it("clears the stop reason", () => {
			const store: StreamingOptimismStore = {
				state: "idle",
				stopReason: "engine_error",
			};
			const next = clearStopReason(store);
			expect(next.stopReason).toBeUndefined();
		});

		it("is idempotent when no reason is set", () => {
			const store: StreamingOptimismStore = { state: "idle" };
			const next = clearStopReason(store);
			expect(next.stopReason).toBeUndefined();
		});

		it("preserves the state", () => {
			const store: StreamingOptimismStore = {
				state: "idle",
				stopReason: "error",
			};
			const next = clearStopReason(store);
			expect(next.state).toBe("idle");
		});
	});

	describe("integration: optimistic transient → reconcile → success", () => {
		it("flows: idle → starting → idle (success)", () => {
			let store = createOptimismStore();
			expect(store.state).toBe("idle");

			// User clicks Start
			store = transitionToStarting(store);
			expect(store.state).toBe("starting");

			// Backend broadcasts is_streaming=true
			store = reconcileToAuthority(store, true);
			expect(store.state).toBe("idle");
			expect(store.stopReason).toBeUndefined();
		});

		it("flows: idle → stopping → idle (success)", () => {
			let store: StreamingOptimismStore = { state: "idle" };

			// User clicks Stop
			store = transitionToStopping(store);
			expect(store.state).toBe("stopping");

			// Backend broadcasts is_streaming=false
			store = reconcileToAuthority(store, false);
			expect(store.state).toBe("idle");
			expect(store.stopReason).toBeUndefined();
		});
	});

	describe("integration: optimistic transient → failure revert", () => {
		it("flows: idle → starting → revert with reason", () => {
			let store = createOptimismStore();

			// User clicks Start
			store = transitionToStarting(store);
			expect(store.state).toBe("starting");

			// Start RPC fails
			store = revertWithReason(store, "no_server_configured");
			expect(store.state).toBe("idle");
			expect(store.stopReason).toBe("no_server_configured");
		});

		it("flows: idle → starting → revert → clear reason", () => {
			let store = createOptimismStore();

			// User clicks Start
			store = transitionToStarting(store);

			// Start fails
			store = revertWithReason(store, "engine_error");
			expect(store.stopReason).toBe("engine_error");

			// User dismisses error toast
			store = clearStopReason(store);
			expect(store.stopReason).toBeUndefined();
		});
	});

	describe("integration: optimistic transient → broadcast failure", () => {
		it("flows: idle → starting → broadcast is_streaming=false (start failed)", () => {
			let store = createOptimismStore();

			// User clicks Start
			store = transitionToStarting(store);
			expect(store.state).toBe("starting");

			// Backend broadcasts is_streaming=false (start failed)
			store = reconcileToAuthority(store, false);
			expect(store.state).toBe("idle");
			// Note: no stop reason here — the broadcast alone doesn't carry the reason.
			// The reason comes from the start RPC rejection or a separate error broadcast.
		});
	});
});
