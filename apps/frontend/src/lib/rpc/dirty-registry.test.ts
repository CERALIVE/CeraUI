/**
 * Unit tests for the PURE dirty-field registry core (Task 19).
 *
 * These exercise the rune-free contract functions directly — no Svelte env, no
 * runes, no reactive store. Time is ALWAYS injected via explicit `now` numbers
 * (never `Date.now()`), so the suite is fully deterministic and flake-free.
 *
 * Coverage map (edge cases E1–E8):
 *   E1 — Rapid spam: TTL resets, latest intendedValue wins, no accumulation
 *   E2 — Unmount/expire: TTL release, then subsequent echo is applied
 *   E3 — Disconnect→reconnect stale echo: pre-edit echo accepted after TTL
 *   E4 — Clamp accepted: resolved + different (clamped) value releases & applies
 *   E5 — Two fields independent: releasing A leaves B locked & still ignoring stale
 *   E6 — Late echo from edit N-1 does NOT release edit N
 *   E7 — Message missing a locked field never releases it
 *   E8 — shouldIgnoreEcho: same value → false, different value → true
 */

import { describe, expect, it } from "vitest";

import {
	createRegistry,
	expire,
	FIELD_LOCK_TTL_MS,
	isLocked,
	onRpcApplied,
	reconcile,
	registryCore,
	shouldIgnoreEcho,
} from "./dirty-registry.svelte";

const T0 = 1_000_000; // arbitrary fixed base timestamp (ms)

describe("dirty-registry pure core", () => {
	// ----------------------------------------------------------------------
	// E1 — Rapid spam: marking pending repeatedly on the same field resets the
	// TTL, keeps only the latest intendedValue, and never accumulates entries.
	// ----------------------------------------------------------------------
	it("E1: rapid spam resets TTL, latest value wins, no accumulation", () => {
		const reg = createRegistry();

		registryCore.markPending(reg, "max_br", 1000, T0);
		registryCore.markPending(reg, "max_br", 2000, T0 + 50);
		registryCore.markPending(reg, "max_br", 3000, T0 + 100);

		// Exactly one lock entry for the field — no timer/entry accumulation.
		expect(Object.keys(reg.locks)).toEqual(["max_br"]);

		const lock = reg.locks.max_br;
		// Latest intended value wins.
		expect(lock.intendedValue).toBe(3000);
		// TTL anchored to the most recent edit (reset, not earliest).
		expect(lock.ts).toBe(T0 + 100);
		// A fresh edit resets the in-flight RPC flag.
		expect(lock.rpcResolved).toBe(false);

		// TTL is measured from the LATEST edit: just-before the latest ts + TTL
		// must NOT expire (proving the timer reset off the earliest edit).
		expect(expire(reg, T0 + 100 + FIELD_LOCK_TTL_MS)).toEqual([]);
		expect(isLocked(reg, "max_br")).toBe(true);
	});

	// ----------------------------------------------------------------------
	// E2 — Unmount/expire: after the TTL elapses the field is released, and a
	// subsequent server echo is then applied normally.
	// ----------------------------------------------------------------------
	it("E2: expire releases the field; subsequent echo is applied", () => {
		const reg = createRegistry();
		registryCore.markPending(reg, "srt_latency", 2000, T0);

		const released = expire(reg, T0 + FIELD_LOCK_TTL_MS + 1);
		expect(released).toEqual(["srt_latency"]);
		expect(isLocked(reg, "srt_latency")).toBe(false);

		// With the lock gone, an incoming echo is applied (and releases nothing).
		const result = reconcile(
			reg,
			"srt_latency",
			4000,
			false,
			T0 + FIELD_LOCK_TTL_MS + 2,
		);
		expect(result).toEqual({ apply: true, released: false });
	});

	// ----------------------------------------------------------------------
	// E3 — Disconnect→reconnect stale echo: edit a field, let the TTL release it,
	// then a reconnect replays the PRE-EDIT config — it is accepted because the
	// lock was already released by the TTL.
	// ----------------------------------------------------------------------
	it("E3: stale pre-edit echo after TTL release is accepted", () => {
		const reg = createRegistry();
		const PRE_EDIT = "manual";
		const INTENDED = "relay";

		registryCore.markPending(reg, "srtla_addr", INTENDED, T0);
		// While still locked, the stale pre-edit echo would be ignored.
		expect(shouldIgnoreEcho(reg, "srtla_addr", PRE_EDIT)).toBe(true);

		// TTL fires (safety valve).
		expect(expire(reg, T0 + FIELD_LOCK_TTL_MS + 1)).toEqual(["srtla_addr"]);
		expect(isLocked(reg, "srtla_addr")).toBe(false);

		// Reconnect replays the pre-edit value — now accepted (no lock to honor).
		expect(shouldIgnoreEcho(reg, "srtla_addr", PRE_EDIT)).toBe(false);
		const result = reconcile(
			reg,
			"srtla_addr",
			PRE_EDIT,
			false,
			T0 + FIELD_LOCK_TTL_MS + 2,
		);
		expect(result).toEqual({ apply: true, released: false });
	});

	// ----------------------------------------------------------------------
	// E4 — Clamp accepted: when the owning RPC has resolved, reconcile against a
	// DIFFERENT (server-clamped) value releases the lock and accepts the clamp.
	// ----------------------------------------------------------------------
	it("E4: resolved RPC accepts a clamped (different) server value", () => {
		const reg = createRegistry();
		registryCore.markPending(reg, "max_br", 12000, T0);
		registryCore.markResolved(reg, "max_br");

		// Server clamps 12000 → 8000. rpcResolved=true forces acceptance + release.
		const result = reconcile(reg, "max_br", 8000, true, T0 + 100);
		expect(result).toEqual({ apply: true, released: true });
		expect(isLocked(reg, "max_br")).toBe(false);
	});

	// ----------------------------------------------------------------------
	// E5 — Two fields independent: lock A and B; releasing A leaves B locked, and
	// a stale echo for B is still ignored after A's release.
	// ----------------------------------------------------------------------
	it("E5: releasing one field leaves the other locked and still guarding", () => {
		const reg = createRegistry();
		registryCore.markPending(reg, "acodec", "opus", T0);
		registryCore.markPending(reg, "delay", 500, T0);

		// Release A (acodec) via a resolved reconcile.
		const aResult = reconcile(reg, "acodec", "opus", true, T0 + 100);
		expect(aResult.released).toBe(true);
		expect(isLocked(reg, "acodec")).toBe(false);

		// B (delay) is untouched — still locked.
		expect(isLocked(reg, "delay")).toBe(true);

		// A stale echo for B (old value) is still ignored while B is locked.
		expect(shouldIgnoreEcho(reg, "delay", 0)).toBe(true);
		const bStale = reconcile(reg, "delay", 0, false, T0 + 150);
		expect(bStale).toEqual({ apply: false, released: false });
		expect(isLocked(reg, "delay")).toBe(true);
	});

	// ----------------------------------------------------------------------
	// E6 — Late echo from edit N-1 does NOT release edit N: resolve+reconcile
	// edit 1, then immediately re-edit (val=2); a late echo of val=1 must NOT be
	// treated as a release of the newer edit.
	// ----------------------------------------------------------------------
	it("E6: late echo from a previous edit does not release the newer edit", () => {
		const reg = createRegistry();

		// Edit N-1: value 1, resolves and is echoed back → released.
		registryCore.markPending(reg, "pipeline", 1, T0);
		registryCore.markResolved(reg, "pipeline");
		const firstRelease = reconcile(reg, "pipeline", 1, true, T0 + 10);
		expect(firstRelease).toEqual({ apply: true, released: true });
		expect(isLocked(reg, "pipeline")).toBe(false);

		// Edit N: re-edit to value 2 (fresh in-flight write, rpcResolved=false).
		registryCore.markPending(reg, "pipeline", 2, T0 + 20);
		expect(reg.locks.pipeline.intendedValue).toBe(2);
		expect(reg.locks.pipeline.rpcResolved).toBe(false);

		// A LATE echo of the old value 1 arrives. It is NOT the intended value and
		// the new edit's RPC has not resolved → must not apply, must not release.
		const lateEcho = reconcile(reg, "pipeline", 1, false, T0 + 25);
		expect(lateEcho).toEqual({ apply: false, released: false });
		expect(isLocked(reg, "pipeline")).toBe(true);
		expect(reg.locks.pipeline.intendedValue).toBe(2);
	});

	// ----------------------------------------------------------------------
	// E7 — Message missing a locked field never releases it: expire within TTL is
	// a no-op, and reconciling a DIFFERENT field cannot touch the locked one.
	// ----------------------------------------------------------------------
	it("E7: a message omitting the locked field does not release it", () => {
		const reg = createRegistry();
		registryCore.markPending(reg, "asrc", "hdmi", T0);

		// expire() within TTL → nothing released, field still locked.
		expect(expire(reg, T0 + 100)).toEqual([]);
		expect(isLocked(reg, "asrc")).toBe(true);

		// A reconcile for a DIFFERENT field (resolved) cannot release 'asrc'.
		const other = reconcile(reg, "acodec", "opus", true, T0 + 120);
		expect(other).toEqual({ apply: true, released: false });
		expect(isLocked(reg, "asrc")).toBe(true);
		expect(reg.locks.asrc.intendedValue).toBe("hdmi");
	});

	// ----------------------------------------------------------------------
	// E8 — shouldIgnoreEcho behavior: a locked field ignores echoes that DIFFER
	// from the intended value, but accepts echoes that MATCH it.
	// ----------------------------------------------------------------------
	it("E8: shouldIgnoreEcho is false on match, true on mismatch", () => {
		const reg = createRegistry();
		registryCore.markPending(reg, "resolution", "1920x1080", T0);

		// Same value as intended → do NOT ignore (the echo matches our intent).
		expect(shouldIgnoreEcho(reg, "resolution", "1920x1080")).toBe(false);
		// Different value (stale pre-edit echo) → ignore.
		expect(shouldIgnoreEcho(reg, "resolution", "1280x720")).toBe(true);

		// Unlocked field → never ignored, regardless of value.
		expect(shouldIgnoreEcho(reg, "framerate", 30)).toBe(false);
	});

	// ----------------------------------------------------------------------
	// E9 — onRpcApplied (clamp): the owning RPC resolves carrying the SERVER-
	// APPLIED (clamped) value. The lock releases immediately to that applied
	// value — not to the client's intended value — without waiting for an echo.
	// ----------------------------------------------------------------------
	it("E9: onRpcApplied releases to the clamped server-applied value", () => {
		const reg = createRegistry();

		// User intends 12000; mark resolved (RPC settled), then applied-state ack.
		registryCore.markPending(reg, "max_br", 12000, T0);
		registryCore.markResolved(reg, "max_br");

		// Server clamped 12000 → 8000. Lock releases to 8000 (the applied value).
		const result = onRpcApplied(reg, "max_br", 8000, T0 + 100);
		expect(result).toEqual({ apply: true, released: true });
		expect(isLocked(reg, "max_br")).toBe(false);

		// onRpcApplied arriving BEFORE the resolve flag adopts the applied value as
		// the new intent (and marks resolved) so the next matching echo releases.
		registryCore.markPending(reg, "srt_latency", 9000, T0 + 200);
		const pending = onRpcApplied(reg, "srt_latency", 5000, T0 + 250);
		expect(pending).toEqual({ apply: true, released: false });
		expect(isLocked(reg, "srt_latency")).toBe(true);
		expect(reg.locks.srt_latency.intendedValue).toBe(5000);
		expect(reg.locks.srt_latency.rpcResolved).toBe(true);
		// A stale echo of the OLD value is still ignored; the applied value matches.
		expect(shouldIgnoreEcho(reg, "srt_latency", 9000)).toBe(true);
		expect(shouldIgnoreEcho(reg, "srt_latency", 5000)).toBe(false);
		const echo = reconcile(reg, "srt_latency", 5000, true, T0 + 300);
		expect(echo).toEqual({ apply: true, released: true });
		expect(isLocked(reg, "srt_latency")).toBe(false);
	});

	// ----------------------------------------------------------------------
	// E10 — TTL(10s) < RPC-timeout(30s): a slow RPC resolves with applied state
	// AFTER the TTL safety valve already released the lock. onRpcApplied must be
	// idempotent — accept the applied value, but NEVER resurrect a stale lock.
	// ----------------------------------------------------------------------
	it("E10: slow RPC applied-state after TTL expiry is safe (no lock resurrection)", () => {
		const reg = createRegistry();
		registryCore.markPending(reg, "max_br", 12000, T0);

		// TTL fires first (10s) — the safety valve releases the field.
		expect(expire(reg, T0 + FIELD_LOCK_TTL_MS + 1)).toEqual(["max_br"]);
		expect(isLocked(reg, "max_br")).toBe(false);

		// The slow RPC resolves later (~within 30s) carrying the applied value.
		const late = onRpcApplied(reg, "max_br", 8000, T0 + 25_000);
		// Idempotent: the applied value is accepted, but no lock is recreated.
		expect(late).toEqual({ apply: true, released: false });
		expect(isLocked(reg, "max_br")).toBe(false);
		expect(Object.keys(reg.locks)).toEqual([]);
	});

	// ----------------------------------------------------------------------
	// E11 — Lock held after pending clears (BondToggle flash-back fix, Task 1):
	// the owning RPC resolves and reports its server-applied value via
	// onRpcApplied while the resolve flag has NOT yet been set (in BondToggle the
	// .then() success path runs BEFORE the finally marks the RPC resolved). The
	// lock must be HELD — not released — so the optimistic value stays on screen
	// until the confirming echo arrives. This is exactly what the new display
	// derivation `(pending || isPending(field)) ? target : enabled` relies on:
	// isPending stays true across the `pending → false` transition, so the toggle
	// never snaps back to the stale `enabled` prop (no flash-back).
	// ----------------------------------------------------------------------
	it("E11: lock held after pending clears — onRpcApplied (pre-resolve) keeps guarding until a matching echo", () => {
		const reg = createRegistry();
		const field = "enabled_wlan0";

		// User toggles bond membership OFF; the RPC is in flight (rpcResolved=false).
		registryCore.markPending(reg, field, false, T0);
		expect(isLocked(reg, field)).toBe(true);
		expect(reg.locks[field].rpcResolved).toBe(false);

		// RPC resolves carrying the server-applied value. Because the resolve flag
		// is still false (finally hasn't run), onRpcApplied takes Case 2: it adopts
		// the applied value as the new intent and marks resolved, but does NOT
		// release. The lock is STILL held — this is the no-flash guarantee.
		const applied = onRpcApplied(reg, field, false, T0 + 5);
		expect(applied).toEqual({ apply: true, released: false });
		expect(isLocked(reg, field)).toBe(true);
		expect(reg.locks[field].rpcResolved).toBe(true);
		expect(reg.locks[field].intendedValue).toBe(false);

		// `pending` clears in the component's finally — but the lock above is held,
		// so a STALE echo of the OLD value (enabled:true) stays ignored and the
		// toggle keeps following `target` (no flash-back to the stale prop).
		expect(shouldIgnoreEcho(reg, field, true)).toBe(true);

		// Only the confirming (matching) echo finally releases the lock, at which
		// point `displayed` can fall through to the now-authoritative `enabled`.
		const echo = reconcile(reg, field, false, true, T0 + 50);
		expect(echo).toEqual({ apply: true, released: true });
		expect(isLocked(reg, field)).toBe(false);
	});
});
