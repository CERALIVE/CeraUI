/**
 * Unit tests for the PURE per-field sync-state machine core (Task 5).
 *
 * These exercise the rune-free lifecycle FSM ({@link syncCore}) directly — no
 * Svelte env, no runes, no reactive store. Time is ALWAYS injected via explicit
 * `now` numbers (never `Date.now()`), so the suite is fully deterministic.
 *
 * Where a behavior is a *composition* with the dirty-registry (the reactive
 * layer wires the two together), the test mirrors that wiring against the
 * dirty-registry's own pure core ({@link registryCore}) — proving the contract
 * the reactive layer relies on, still without runes.
 *
 * Coverage map:
 *   S1  — Happy path: idle → pending → applying → applied (transitions in order)
 *   S2  — Reject path: idle → pending → applying → failed
 *   S3  — `applied`/`failed` are only reachable from an in-flight phase
 *   S4  — Composition: `applied` releases the lock to result.applied (a clamped
 *         server value), NEVER the client's intended value
 *   S5  — In-flight TTL valve: a stuck pending/applying releases to idle
 *   S6  — Terminal decay: applied/failed linger, then decay to idle
 *   S7  — Status-field exclusion (G4): status fields never enter the machine and
 *         never take a dirty-registry lock
 *   S8  — Re-edit resets the TTL and re-enters pending
 *   S9  — Two fields advance independently
 */

import { describe, expect, it } from "vitest";

import {
	createRegistry,
	FIELD_LOCK_TTL_MS,
	isLocked,
	registryCore,
} from "./dirty-registry.svelte";
import {
	createSyncRegistry,
	getState,
	isStatusField,
	STATUS_FIELDS,
	syncCore,
	TERMINAL_LINGER_MS,
} from "./field-sync-state.svelte";

const T0 = 1_000_000; // arbitrary fixed base timestamp (ms)

describe("field-sync-state pure core", () => {
	// ----------------------------------------------------------------------
	// S1 — Happy path: the lifecycle advances idle → pending → applying →
	// applied, in order, and each transition reports success.
	// ----------------------------------------------------------------------
	it("S1: advances idle → pending → applying → applied in order", () => {
		const reg = createSyncRegistry();
		expect(getState(reg, "max_br")).toBe("idle");

		expect(syncCore.beginPending(reg, "max_br", T0)).toBe(true);
		expect(getState(reg, "max_br")).toBe("pending");

		expect(syncCore.beginApplying(reg, "max_br", T0 + 10)).toBe(true);
		expect(getState(reg, "max_br")).toBe("applying");

		expect(syncCore.markApplied(reg, "max_br", T0 + 20)).toBe(true);
		expect(getState(reg, "max_br")).toBe("applied");
	});

	// ----------------------------------------------------------------------
	// S2 — Reject path: a write that reaches `applying` and then has its RPC
	// reject transitions to `failed`, not `applied`.
	// ----------------------------------------------------------------------
	it("S2: applying → failed on RPC reject", () => {
		const reg = createSyncRegistry();
		syncCore.beginPending(reg, "acodec", T0);
		syncCore.beginApplying(reg, "acodec", T0 + 10);

		expect(syncCore.markFailed(reg, "acodec", T0 + 20)).toBe(true);
		expect(getState(reg, "acodec")).toBe("failed");
	});

	// ----------------------------------------------------------------------
	// S3 — `applied` (and `failed`) are reachable ONLY from an in-flight phase.
	// Calling them on an idle field is a no-op — this is what guarantees a field
	// is never shown as "applied" without a preceding in-flight write, and keeps
	// a TTL-released field from being revived. `applying` likewise requires a
	// preceding `pending`.
	// ----------------------------------------------------------------------
	it("S3: applied/applying/failed are no-ops from idle", () => {
		const reg = createSyncRegistry();

		expect(syncCore.markApplied(reg, "delay", T0)).toBe(false);
		expect(getState(reg, "delay")).toBe("idle");

		expect(syncCore.beginApplying(reg, "delay", T0)).toBe(false);
		expect(getState(reg, "delay")).toBe("idle");

		expect(syncCore.markFailed(reg, "delay", T0)).toBe(false);
		expect(getState(reg, "delay")).toBe("idle");

		// And once terminal, a stale transition cannot re-fire it (must re-begin).
		syncCore.beginPending(reg, "delay", T0);
		syncCore.beginApplying(reg, "delay", T0 + 1);
		syncCore.markApplied(reg, "delay", T0 + 2);
		expect(syncCore.markFailed(reg, "delay", T0 + 3)).toBe(false);
		expect(getState(reg, "delay")).toBe("applied");
	});

	// ----------------------------------------------------------------------
	// S4 — Composition contract: when the RPC resolves, the lock is released to
	// the SERVER-APPLIED value (here a clamp: 12000 → 8000), never the client's
	// intended value. This mirrors what the reactive `markFieldApplied` wires:
	// onRpcResolved + onRpcApplied(appliedValue) on the dirty-registry, plus the
	// FSM flip to `applied`.
	// ----------------------------------------------------------------------
	it("S4: applied releases the lock to result.applied, not the intended value", () => {
		const sync = createSyncRegistry();
		const dirty = createRegistry();
		const INTENDED = 12000;
		const APPLIED = 8000; // server clamp

		// begin: FSM pending + dirty-registry lock holds the intended value.
		syncCore.beginPending(sync, "max_br", T0);
		registryCore.markPending(dirty, "max_br", INTENDED, T0);
		syncCore.beginApplying(sync, "max_br", T0 + 5);
		expect(dirty.locks.max_br?.intendedValue).toBe(INTENDED);

		// resolve: the reactive layer's exact composition.
		registryCore.markResolved(dirty, "max_br");
		const released = registryCore.onRpcApplied(
			dirty,
			"max_br",
			APPLIED,
			T0 + 10,
		);
		syncCore.markApplied(sync, "max_br", T0 + 10);

		// Lock released to the CLAMPED server value, and the FSM reads `applied`.
		expect(released).toEqual({ apply: true, released: true });
		expect(isLocked(dirty, "max_br")).toBe(false);
		expect(getState(sync, "max_br")).toBe("applied");
	});

	// ----------------------------------------------------------------------
	// S5 — In-flight TTL valve: a field stuck in `applying` (no echo, orphaned
	// RPC) is force-released to idle once older than FIELD_LOCK_TTL_MS — the
	// spinner can never hang forever. Within the TTL it is NOT swept.
	// ----------------------------------------------------------------------
	it("S5: a stuck in-flight field is TTL-released to idle", () => {
		const reg = createSyncRegistry();
		syncCore.beginPending(reg, "srtla_addr", T0);
		syncCore.beginApplying(reg, "srtla_addr", T0);

		// Just before the TTL: nothing swept.
		expect(syncCore.sweepSync(reg, T0 + FIELD_LOCK_TTL_MS)).toEqual([]);
		expect(getState(reg, "srtla_addr")).toBe("applying");

		// Past the TTL: released to idle.
		expect(syncCore.sweepSync(reg, T0 + FIELD_LOCK_TTL_MS + 1)).toEqual([
			"srtla_addr",
		]);
		expect(getState(reg, "srtla_addr")).toBe("idle");
	});

	// ----------------------------------------------------------------------
	// S6 — Terminal decay: `applied` / `failed` linger TERMINAL_LINGER_MS so the
	// confirmation/error affordance registers, then decay to idle. They decay on
	// the SHORTER terminal clock, not the in-flight TTL.
	// ----------------------------------------------------------------------
	it("S6: terminal phases linger, then decay to idle", () => {
		const reg = createSyncRegistry();
		syncCore.beginPending(reg, "resolution", T0);
		syncCore.beginApplying(reg, "resolution", T0);
		syncCore.markApplied(reg, "resolution", T0);

		// Within the linger window: still showing `applied`.
		expect(syncCore.sweepSync(reg, T0 + TERMINAL_LINGER_MS)).toEqual([]);
		expect(getState(reg, "resolution")).toBe("applied");

		// Past it: decayed to idle.
		expect(syncCore.sweepSync(reg, T0 + TERMINAL_LINGER_MS + 1)).toEqual([
			"resolution",
		]);
		expect(getState(reg, "resolution")).toBe("idle");
	});

	// ----------------------------------------------------------------------
	// S7 — Status-field exclusion (G4): a status field is refused at the entry
	// point — it never gets a lifecycle entry, and (mirroring the reactive layer)
	// the dirty-registry lock is therefore never taken. Status fields stay out of
	// both stores entirely.
	// ----------------------------------------------------------------------
	it("S7: status fields are excluded from the machine and the dirty-registry", () => {
		const sync = createSyncRegistry();
		const dirty = createRegistry();

		expect(isStatusField("is_streaming")).toBe(true);

		// The reactive layer's guard: beginPending refuses, so markPending is skipped.
		const admitted = syncCore.beginPending(sync, "is_streaming", T0);
		if (admitted) registryCore.markPending(dirty, "is_streaming", true, T0);

		expect(admitted).toBe(false);
		expect(getState(sync, "is_streaming")).toBe("idle");
		expect(isLocked(dirty, "is_streaming")).toBe(false);

		// Every advertised status field is refused.
		for (const field of STATUS_FIELDS) {
			expect(syncCore.beginPending(createSyncRegistry(), field, T0)).toBe(
				false,
			);
		}
	});

	// ----------------------------------------------------------------------
	// S8 — Re-edit resets the TTL and re-enters `pending`. A second edit while a
	// terminal phase lingers restarts the lifecycle cleanly.
	// ----------------------------------------------------------------------
	it("S8: re-editing re-enters pending and resets the TTL", () => {
		const reg = createSyncRegistry();
		syncCore.beginPending(reg, "max_br", T0);
		syncCore.beginApplying(reg, "max_br", T0);
		syncCore.markApplied(reg, "max_br", T0);
		expect(getState(reg, "max_br")).toBe("applied");

		// User edits again well after the first edit — back to `pending`, TTL reset.
		expect(syncCore.beginPending(reg, "max_br", T0 + 100)).toBe(true);
		expect(getState(reg, "max_br")).toBe("pending");

		// The TTL is anchored to the NEW edit: a sweep at (old ts + TTL) is inert.
		expect(syncCore.sweepSync(reg, T0 + 100 + FIELD_LOCK_TTL_MS)).toEqual([]);
		expect(getState(reg, "max_br")).toBe("pending");
	});

	// ----------------------------------------------------------------------
	// S9 — Two fields advance independently: failing one leaves the other's
	// in-flight phase untouched.
	// ----------------------------------------------------------------------
	it("S9: fields advance independently", () => {
		const reg = createSyncRegistry();
		syncCore.beginPending(reg, "max_br", T0);
		syncCore.beginApplying(reg, "max_br", T0);
		syncCore.beginPending(reg, "acodec", T0);
		syncCore.beginApplying(reg, "acodec", T0);

		syncCore.markFailed(reg, "acodec", T0 + 10);

		expect(getState(reg, "acodec")).toBe("failed");
		expect(getState(reg, "max_br")).toBe("applying");
	});
});
