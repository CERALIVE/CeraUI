/**
 * Unit tests for streaming-optimism.svelte.ts
 *
 * Tests the pure core functions (rune-free) for optimistic state transitions,
 * reconciliation to authoritative broadcast, and failure revert with reason.
 */

import type { StartFailure } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import {
	clearStopReason,
	createOptimismStore,
	reconcileToAuthority,
	revertWithFailure,
	revertWithReason,
	type StreamingOptimismStore,
	transitionToStarting,
	transitionToStopping,
} from "./streaming-optimism.svelte";

function failure(overrides: Partial<StartFailure> = {}): StartFailure {
	return {
		attemptId: "att_test",
		phase: "connect",
		class: "engine_unavailable",
		retriable: true,
		...overrides,
	};
}

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

	describe("reconcileToAuthority (truth table)", () => {
		it("starting + true → idle (confirmed)", () => {
			const store: StreamingOptimismStore = { state: "starting" };
			const next = reconcileToAuthority(store, true);
			expect(next.state).toBe("idle");
			expect(next.stopReason).toBeUndefined();
		});

		it("starting + false → KEEP starting (ignores contradicting push)", () => {
			const store: StreamingOptimismStore = { state: "starting" };
			const next = reconcileToAuthority(store, false);
			expect(next.state).toBe("starting");
		});

		it("stopping + false → idle (confirmed)", () => {
			const store: StreamingOptimismStore = { state: "stopping" };
			const next = reconcileToAuthority(store, false);
			expect(next.state).toBe("idle");
			expect(next.stopReason).toBeUndefined();
		});

		it("stopping + true → KEEP stopping (ignores contradicting push)", () => {
			const store: StreamingOptimismStore = { state: "stopping" };
			const next = reconcileToAuthority(store, true);
			expect(next.state).toBe("stopping");
		});

		it("idle + false → no-op (already at truth)", () => {
			const store: StreamingOptimismStore = { state: "idle" };
			const next = reconcileToAuthority(store, false);
			expect(next.state).toBe("idle");
		});

		it("idle + true → no-op (autostart owned by authoritative store)", () => {
			const store: StreamingOptimismStore = { state: "idle" };
			const next = reconcileToAuthority(store, true);
			expect(next.state).toBe("idle");
		});

		it("clears stop reason on confirmed reconcile", () => {
			const store: StreamingOptimismStore = {
				state: "starting",
				stopReason: "old_error",
			};
			const next = reconcileToAuthority(store, true);
			expect(next.stopReason).toBeUndefined();
		});

		it("preserves stop reason when keeping the transient state", () => {
			const store: StreamingOptimismStore = {
				state: "starting",
				stopReason: "old_error",
			};
			const next = reconcileToAuthority(store, false);
			expect(next.state).toBe("starting");
			expect(next.stopReason).toBe("old_error");
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

	describe("integration: optimistic transient → contradicting broadcast", () => {
		it("flows: idle → starting → stale is_streaming=false ignored → is_streaming=true confirms", () => {
			let store = createOptimismStore();

			store = transitionToStarting(store);
			expect(store.state).toBe("starting");

			store = reconcileToAuthority(store, false);
			expect(store.state).toBe("starting");

			store = reconcileToAuthority(store, true);
			expect(store.state).toBe("idle");
			expect(store.stopReason).toBeUndefined();
		});

		it("flows: idle → starting → revert with reason (RPC rejection, not a broadcast)", () => {
			let store = createOptimismStore();

			store = transitionToStarting(store);
			expect(store.state).toBe("starting");

			store = revertWithReason(store, "no_server_configured");
			expect(store.state).toBe("idle");
			expect(store.stopReason).toBe("no_server_configured");
		});
	});

	describe("generation identity (Todo 29)", () => {
		it("mints a fresh generation on every transitionToStarting", () => {
			let store = createOptimismStore();
			const g0 = store.generation;

			store = transitionToStarting(store);
			const g1 = store.generation;
			expect(g1).toBeGreaterThan(g0);

			store = reconcileToAuthority(store, true); // confirm attempt 1
			store = transitionToStarting(store); // attempt 2
			expect(store.generation).toBeGreaterThan(g1);
		});

		it("IGNORES a revert carrying an OLDER attempt's generation (stale response)", () => {
			// Attempt 1 begins.
			let store = transitionToStarting(createOptimismStore());
			const staleGen = store.generation;

			// Attempt 1 confirmed, then a NEWER attempt 2 begins.
			store = reconcileToAuthority(store, true);
			store = transitionToStarting(store);
			expect(store.state).toBe("starting");

			// Attempt 1's DELAYED failure reply lands late, tagged with its old gen.
			const next = revertWithReason(store, "engine_error", staleGen);

			// It must NOT clobber attempt 2 — same object returned, still starting.
			expect(next).toBe(store);
			expect(next.state).toBe("starting");
			expect(next.stopReason).toBeUndefined();
		});

		it("APPLIES a revert carrying the CURRENT attempt's generation", () => {
			let store = transitionToStarting(createOptimismStore());
			const gen = store.generation;

			store = revertWithReason(store, "engine_error", gen);
			expect(store.state).toBe("idle");
			expect(store.stopReason).toBe("engine_error");
		});

		it("IGNORES a typed-failure revert from an OLDER generation", () => {
			let store = transitionToStarting(createOptimismStore());
			const staleGen = store.generation;

			store = reconcileToAuthority(store, true);
			store = transitionToStarting(store); // newer attempt

			const next = revertWithFailure(store, failure(), staleGen);
			expect(next).toBe(store);
			expect(next.state).toBe("starting");
			expect(next.failure).toBeUndefined();
		});

		it("a revert with NO generation is unconditional (legacy caller)", () => {
			let store = transitionToStarting(createOptimismStore());
			store = revertWithReason(store, "engine_error");
			expect(store.state).toBe("idle");
			expect(store.stopReason).toBe("engine_error");
		});
	});

	describe("typed failure revert (Todo 29)", () => {
		it("reverts to idle carrying the typed failure + a string stopReason", () => {
			let store = transitionToStarting(createOptimismStore());
			const f = failure({ class: "start_invalid", retriable: false });

			store = revertWithFailure(store, f, store.generation);
			expect(store.state).toBe("idle");
			expect(store.failure).toEqual(f);
			expect(store.stopReason).toBe("start_invalid");
		});

		it("uses a string `code` as stopReason when present", () => {
			let store = transitionToStarting(createOptimismStore());
			const f = failure({ code: "audio_device_unavailable" });

			store = revertWithFailure(store, f, store.generation);
			expect(store.stopReason).toBe("audio_device_unavailable");
		});

		it("transitionToStarting clears a prior typed failure", () => {
			let store = transitionToStarting(createOptimismStore());
			store = revertWithFailure(store, failure(), store.generation);
			expect(store.failure).toBeDefined();

			store = transitionToStarting(store);
			expect(store.failure).toBeUndefined();
			expect(store.stopReason).toBeUndefined();
		});

		it("reconcile-confirm clears a lingering typed failure", () => {
			let store = transitionToStarting(createOptimismStore());
			store = revertWithFailure(store, failure(), store.generation);
			store = transitionToStarting(store);

			store = reconcileToAuthority(store, true);
			expect(store.state).toBe("idle");
			expect(store.failure).toBeUndefined();
		});
	});
});
