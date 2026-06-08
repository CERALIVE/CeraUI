/**
 * Task 29 — reconnect-aware in-flight reconciliation (pure core).
 *
 * Exercises {@link shouldReconcileOnReconnect} directly under the plain (node)
 * vitest environment — no runes, no component mount — mirroring the rune-free
 * unit suites for `dirty-registry` and `connection-ux`.
 */
import { describe, expect, it } from "vitest";

import { shouldReconcileOnReconnect } from "./reconcile-inflight";

describe("shouldReconcileOnReconnect — reconnect-edge gate (Task 29)", () => {
	it("reconciles on the reconnect edge (→ connected) while a toggle is pending", () => {
		expect(shouldReconcileOnReconnect("disconnected", "connected", true)).toBe(
			true,
		);
		expect(shouldReconcileOnReconnect("connecting", "connected", true)).toBe(
			true,
		);
		expect(shouldReconcileOnReconnect("error", "connected", true)).toBe(true);
	});

	it("does NOT reconcile when nothing is in flight", () => {
		expect(shouldReconcileOnReconnect("disconnected", "connected", false)).toBe(
			false,
		);
		expect(shouldReconcileOnReconnect("connecting", "connected", false)).toBe(
			false,
		);
	});

	it("does NOT reconcile on a steady connected→connected tick (no edge)", () => {
		// An unrelated re-render must never race a normally-settling RPC's finally.
		expect(shouldReconcileOnReconnect("connected", "connected", true)).toBe(
			false,
		);
	});

	it("does NOT reconcile on the disconnect edge (→ not connected)", () => {
		expect(shouldReconcileOnReconnect("connected", "disconnected", true)).toBe(
			false,
		);
		expect(shouldReconcileOnReconnect("connected", "connecting", true)).toBe(
			false,
		);
		expect(shouldReconcileOnReconnect("connected", "error", true)).toBe(false);
	});
});
