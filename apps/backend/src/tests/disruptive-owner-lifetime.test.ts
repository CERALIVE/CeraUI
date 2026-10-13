import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	isDisruptiveActionPending,
	reserveDisruptiveAction,
	resetDisruptiveActionReservationForTest,
} from "../modules/system/disruptive-action-reservation.ts";

beforeEach(resetDisruptiveActionReservationForTest);
afterEach(resetDisruptiveActionReservationForTest);

test("same active owner re-enters and only its outermost completion releases", () => {
	// Given one operation already owning the service lifetime.
	const owner = Symbol("addon-a");
	const outer = reserveDisruptiveAction({ allowed: true }, "service", owner);
	if (!outer.allowed) throw new Error("outer refused");
	// When its nested step finishes before the outer operation.
	const inner = reserveDisruptiveAction({ allowed: true }, "service", owner);
	expect(inner.allowed).toBe(true);
	if (!inner.allowed) throw new Error("nested refused");
	inner.reservation.releaseAfterCompletion();
	inner.reservation.releaseAfterCompletion();
	// Then a repeated inner release cannot consume the outer depth.
	expect(isDisruptiveActionPending()).toBe(true);
	outer.reservation.releaseAfterCompletion();
	expect(isDisruptiveActionPending()).toBe(false);
});

test("a different addon owner is refused while the first owns the lifetime", () => {
	// Given an active first owner.
	reserveDisruptiveAction({ allowed: true }, "service", Symbol("addon-a"));
	// When another operation arrives.
	const second = reserveDisruptiveAction(
		{ allowed: true },
		"service",
		Symbol("addon-b"),
	);
	// Then identity is not shared authority.
	expect(second).toEqual({ allowed: false, reason: "update_in_progress" });
});

test("a released owner cannot resurrect its authority in a timer descendant", () => {
	// Given a completed operation with a retained symbol.
	const owner = Symbol("addon-a");
	const first = reserveDisruptiveAction({ allowed: true }, "service", owner);
	if (!first.allowed) throw new Error("outer refused");
	first.reservation.releaseAfterCompletion();
	// When its descendant uses stale identity against an otherwise free device.
	const late = reserveDisruptiveAction({ allowed: true }, "service", owner);
	// Then the old lifetime cannot be re-opened.
	expect(late).toEqual({ allowed: false, reason: "update_in_progress" });
});

test("nested positive exception releases its depth without releasing the owner", () => {
	// Given a nested acquired step.
	const owner = Symbol("addon-a");
	const outer = reserveDisruptiveAction({ allowed: true }, "service", owner);
	const inner = reserveDisruptiveAction({ allowed: true }, "service", owner);
	if (!outer.allowed || !inner.allowed) throw new Error("reserve refused");
	// When the inner fails before a successful outer completion.
	inner.reservation.releaseAfterFailure();
	// Then failure cannot clear its still-running parent.
	expect(isDisruptiveActionPending()).toBe(true);
	outer.reservation.releaseAfterCompletion();
	expect(isDisruptiveActionPending()).toBe(false);
});
