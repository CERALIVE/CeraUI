/**
 * Unit tests for the Live destination apply/reconcile decisions — Task 15.
 *
 * Two contracts are proven here, both rune-free (no Svelte env, no runes):
 *
 *   1. Applied-lock release for `setBitrate`: the `max_br` field-lock releases to
 *      the SERVER-APPLIED value (`result.applied`, T9 envelope) on a normal
 *      apply — never the optimistic value the client typed — and CLEARS to
 *      server truth on failure (`success:false`) or an RPC reject, so the slider
 *      is never stuck.
 *   2. switchInput reconnect reconciliation: a stuck live-switch latch is
 *      cleared on the reconnect edge so the input picker reconciles to the
 *      server-reported active input instead of a stale optimistic value.
 *
 * The setBitrate tests mirror the EXACT wiring `commitBitrate` performs against
 * the dirty-registry pure core — `markPending(intended)` → `markResolved` →
 * `onRpcApplied(resolveAppliedBitrate(...))` — proving the composition the
 * reactive layer relies on, still without runes (same approach as
 * `field-sync-state.test.ts` S4).
 */
import type { BitrateOutput } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import type { ConnectionState } from "./client";
import {
	createRegistry,
	isLocked,
	registryCore,
} from "./dirty-registry.svelte";
import {
	reconcileSwitchingInput,
	resolveAppliedBitrate,
} from "./live-apply-reconcile";

const T0 = 1_000_000; // arbitrary fixed base timestamp (ms)

describe("resolveAppliedBitrate (Task 15)", () => {
	it("returns result.applied on a normal apply, not the optimistic value", () => {
		const res: BitrateOutput = { success: true, applied: 8000 };
		// intended (typed) = 12000, server clamped to 8000 → release to 8000.
		expect(resolveAppliedBitrate(res, 12000, 6000)).toBe(8000);
	});

	it("falls back to the intended value when the server omits applied", () => {
		const res: BitrateOutput = { success: true };
		expect(resolveAppliedBitrate(res, 12000, 6000)).toBe(12000);
	});

	it("on success:false reconciles to the last known server value, never the optimistic value", () => {
		const res: BitrateOutput = { success: false, error: { message: "rejected" } };
		expect(resolveAppliedBitrate(res, 12000, 6000)).toBe(6000);
	});

	it("on success:false with no known server value falls back to intended", () => {
		const res: BitrateOutput = { success: false };
		expect(resolveAppliedBitrate(res, 12000, undefined)).toBe(12000);
	});
});

describe("setBitrate field-lock composition (Task 15)", () => {
	// ----------------------------------------------------------------------
	// Normal apply: the lock releases to result.applied (a clamped server
	// value), NEVER the client's intended value. This is the exact composition
	// commitBitrate wires on the success branch.
	// ----------------------------------------------------------------------
	it("normal apply: the lock releases to result.applied, never the intended value", () => {
		const dirty = createRegistry();
		const INTENDED = 12000;
		const res: BitrateOutput = { success: true, applied: 8000 };

		registryCore.markPending(dirty, "max_br", INTENDED, T0);
		expect(dirty.locks.max_br?.intendedValue).toBe(INTENDED);

		// RPC resolves: mark resolved, then release to the resolved applied value.
		registryCore.markResolved(dirty, "max_br");
		const applied = resolveAppliedBitrate(res, INTENDED, 6000);
		const out = registryCore.onRpcApplied(dirty, "max_br", applied, T0 + 10);

		expect(applied).toBe(8000);
		expect(out).toEqual({ apply: true, released: true });
		expect(isLocked(dirty, "max_br")).toBe(false);
	});

	// ----------------------------------------------------------------------
	// Failure (success:false): the optimistic lock CLEARS and reconciles to the
	// server value — the slider is never stuck on the unconfirmed typed value.
	// ----------------------------------------------------------------------
	it("failure (success:false): the optimistic lock CLEARS and reconciles to server truth", () => {
		const dirty = createRegistry();
		const INTENDED = 12000;
		const SERVER = 6000;
		const res: BitrateOutput = { success: false };

		registryCore.markPending(dirty, "max_br", INTENDED, T0);
		registryCore.markResolved(dirty, "max_br");
		const applied = resolveAppliedBitrate(res, INTENDED, SERVER);
		const out = registryCore.onRpcApplied(dirty, "max_br", applied, T0 + 10);

		expect(applied).toBe(SERVER);
		expect(out).toEqual({ apply: true, released: true });
		expect(isLocked(dirty, "max_br")).toBe(false);
	});

	// ----------------------------------------------------------------------
	// Reject (RPC threw): commitBitrate's catch path releases the lock to the
	// authoritative server value — again, never stuck.
	// ----------------------------------------------------------------------
	it("rejected RPC: the catch path clears the lock to server truth", () => {
		const dirty = createRegistry();
		const INTENDED = 12000;
		const SERVER = 6000;

		registryCore.markPending(dirty, "max_br", INTENDED, T0);
		// catch: onRpcResolved + onRpcApplied(authoritative).
		registryCore.markResolved(dirty, "max_br");
		const out = registryCore.onRpcApplied(dirty, "max_br", SERVER, T0 + 10);

		expect(out).toEqual({ apply: true, released: true });
		expect(isLocked(dirty, "max_br")).toBe(false);
	});

	// ----------------------------------------------------------------------
	// A late settle (after the TTL valve already released the field) must NEVER
	// resurrect a stale lock — applying the applied value to view state is fine.
	// ----------------------------------------------------------------------
	it("a late settle after the TTL valve never resurrects a stale lock", () => {
		const dirty = createRegistry();
		const out = registryCore.onRpcApplied(dirty, "max_br", 6000, T0);
		expect(out).toEqual({ apply: true, released: false });
		expect(isLocked(dirty, "max_br")).toBe(false);
	});
});

describe("reconcileSwitchingInput — switchInput reconnect reconciliation (Task 15)", () => {
	it("clears the stuck latch on the reconnect edge so the picker reconciles to server truth", () => {
		expect(reconcileSwitchingInput("disconnected", "connected", "hdmi:1")).toBeUndefined();
	});

	it("does not clear on a steady connected tick (no false reconcile)", () => {
		expect(reconcileSwitchingInput("connected", "connected", "hdmi:1")).toBe("hdmi:1");
	});

	it("does not clear on the disconnect edge — only on the reconnect edge", () => {
		expect(reconcileSwitchingInput("connected", "disconnected", "hdmi:1")).toBe("hdmi:1");
	});

	it("is a no-op when nothing is switching", () => {
		expect(reconcileSwitchingInput("disconnected", "connected", undefined)).toBeUndefined();
	});

	// ----------------------------------------------------------------------
	// Full cycle: switch forces a reconnect that orphans the RPC, leaving the
	// latch stuck across the drop; on the reconnect edge the latch clears so the
	// picker shows the server-reported active input, not the stale optimistic id.
	// ----------------------------------------------------------------------
	it("reconnect cycle: a stuck switch latch reconciles to the server-reported active input", () => {
		const activeInput = "hdmi:0"; // authoritative subscription value (server truth)
		let switchingInput: string | undefined = "hdmi:1"; // optimistic in-flight target
		let prev: ConnectionState = "connected";

		// WS drops mid-switch — no reconcile (not a → connected edge).
		switchingInput = reconcileSwitchingInput(prev, "disconnected", switchingInput);
		prev = "disconnected";
		expect(switchingInput).toBe("hdmi:1");

		// WS returns — the orphaned RPC's latch is dropped on the reconnect edge.
		switchingInput = reconcileSwitchingInput(prev, "connected", switchingInput);
		prev = "connected";
		expect(switchingInput).toBeUndefined();

		// The picker now reconciles to the server-reported active input.
		const displayedActive = switchingInput ?? activeInput;
		expect(displayedActive).toBe(activeInput);
	});
});
