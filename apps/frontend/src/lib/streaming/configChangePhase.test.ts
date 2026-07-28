import { describe, expect, it } from "vitest";

import {
	type ConfigChangeView,
	isConfigChangeInFlight,
	reduceConfigChange,
} from "./configChangePhase";

const APPLYING = { attemptId: "a2", phase: "applying" } as const;

describe("config-change attempt fencing", () => {
	it("adopts a fresh applying phase", () => {
		// When the first phase of a transaction arrives.
		const next = reduceConfigChange(undefined, APPLYING);

		// Then it becomes the rendered view.
		expect(next).toEqual({ attemptId: "a2", phase: "applying" });
		expect(isConfigChangeInFlight(next)).toBe(true);
	});

	it("lets a NEWER applying supersede an older in-flight attempt", () => {
		// Given attempt a1 in flight.
		const current: ConfigChangeView = { attemptId: "a1", phase: "applying" };

		// When a newer attempt starts.
		const next = reduceConfigChange(current, APPLYING);

		// Then the newer attempt owns the view.
		expect(next?.attemptId).toBe("a2");
	});

	it("IGNORES a terminal phase from a superseded attempt", () => {
		// Given attempt a2 in flight.
		const current: ConfigChangeView = { attemptId: "a2", phase: "applying" };

		// When a late terminal phase from the older a1 arrives.
		const next = reduceConfigChange(current, {
			attemptId: "a1",
			phase: "applied",
		});

		// Then the current transaction is untouched — no false "applied".
		expect(next).toEqual(current);
		expect(isConfigChangeInFlight(next)).toBe(true);
	});

	it("settles the CURRENT attempt on its own terminal phase, carrying the reason", () => {
		// Given attempt a2 in flight.
		const current: ConfigChangeView = { attemptId: "a2", phase: "applying" };

		// When its own rollback_failed arrives.
		const next = reduceConfigChange(current, {
			attemptId: "a2",
			phase: "rollback_failed",
			reason: "teardown_timeout",
		});

		// Then the banner clears and the honest reason is available to render.
		expect(next).toEqual({
			attemptId: "a2",
			phase: "rollback_failed",
			reason: "teardown_timeout",
		});
		expect(isConfigChangeInFlight(next)).toBe(false);
	});

	it("ADOPTS a terminal phase for an unknown attempt — the applying may have fired before anyone listened", () => {
		// Given a client that connected mid-transaction and never saw `applying`.
		// When the only phase it receives is the outcome.
		const next = reduceConfigChange(undefined, {
			attemptId: "a9",
			phase: "reverted",
			reason: "not_negotiated",
		});

		// Then it is rendered rather than silently swallowed.
		expect(next?.phase).toBe("reverted");
		expect(next?.reason).toBe("not_negotiated");
	});

	it("does not treat a terminal phase as in-flight", () => {
		expect(isConfigChangeInFlight(undefined)).toBe(false);
		expect(isConfigChangeInFlight({ attemptId: "a1", phase: "applied" })).toBe(
			false,
		);
	});
});
