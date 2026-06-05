/**
 * Task 14 — stream-health store (runes + pure logic).
 *
 * Mirrors the `notifications.svelte.ts` testing split: all decision logic lives
 * in *pure*, rune-free functions ({@link parseHealthState}, {@link reduceHealth},
 * {@link notificationForTransition}) exercisable directly, plus a reactive store
 * suite that drives ingestion end-to-end and asserts the transition toasts land
 * in the central notification store.
 *
 * `stream-health.svelte.ts` imports `notifications.svelte.ts`, which statically
 * imports `@ceraui/i18n/svelte` (declares Svelte runes). Mock it so importing
 * the store resolves `$LL` to a plain tree rather than evaluating the adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ceraui/i18n/svelte", () => ({
	getLL: vi.fn(() => ({})),
}));

import { clearNotifications, getActive } from "./notifications.svelte";
import {
	type HealthIndicator,
	type HealthSnapshot,
	getStreamHealthSnapshot,
	getStreamHealthState,
	ingestStreamHealth,
	initialHealthSnapshot,
	notificationForTransition,
	parseHealthState,
	reduceHealth,
	resetStreamHealth,
} from "./stream-health.svelte";

// ============================================
// parseHealthState
// ============================================

describe("parseHealthState", () => {
	it("reads each valid backend state from the payload", () => {
		expect(parseHealthState({ state: "healthy" })).toBe("healthy");
		expect(parseHealthState({ state: "degraded" })).toBe("degraded");
		expect(parseHealthState({ state: "dead" })).toBe("dead");
	});

	it("collapses an unrecognised state string to `unknown`", () => {
		expect(parseHealthState({ state: "exploded" })).toBe("unknown");
		expect(parseHealthState({ state: "" })).toBe("unknown");
	});

	it("collapses missing / non-object / null payloads to `unknown` (never throws)", () => {
		expect(parseHealthState(undefined)).toBe("unknown");
		expect(parseHealthState(null)).toBe("unknown");
		expect(parseHealthState({})).toBe("unknown");
		expect(parseHealthState("dead")).toBe("unknown");
		expect(parseHealthState(42)).toBe("unknown");
		expect(parseHealthState({ state: 1 })).toBe("unknown");
	});

	it("ignores extra fields and reads only `state`", () => {
		expect(
			parseHealthState({
				state: "degraded",
				process: { alive: true },
				frames: { advancing: false, count: 0 },
			}),
		).toBe("degraded");
	});
});

// ============================================
// reduceHealth
// ============================================

describe("reduceHealth", () => {
	it("promotes the new value to `current` and preserves the prior `current` as `previous`", () => {
		const start = initialHealthSnapshot();
		expect(start).toEqual({ current: "unknown", previous: "unknown" });

		const a = reduceHealth(start, "healthy");
		expect(a).toEqual({ current: "healthy", previous: "unknown" });

		const b = reduceHealth(a, "degraded");
		expect(b).toEqual({ current: "degraded", previous: "healthy" });

		const c = reduceHealth(b, "dead");
		expect(c).toEqual({ current: "dead", previous: "degraded" });
	});

	it("advances `previous` even when the state repeats (current === previous = no transition)", () => {
		const a: HealthSnapshot = { current: "healthy", previous: "unknown" };
		const b = reduceHealth(a, "healthy");
		expect(b).toEqual({ current: "healthy", previous: "healthy" });
		expect(b.current === b.previous).toBe(true);
	});
});

// ============================================
// notificationForTransition
// ============================================

describe("notificationForTransition", () => {
	it("returns null when the state did not change", () => {
		expect(notificationForTransition("healthy", "healthy")).toBeNull();
		expect(notificationForTransition("degraded", "degraded")).toBeNull();
		expect(notificationForTransition("dead", "dead")).toBeNull();
	});

	it("raises a warning toast on healthy → degraded", () => {
		const n = notificationForTransition("healthy", "degraded");
		expect(n?.type).toBe("warning");
		expect(n?.name).toBe("stream-health-degraded");
		expect(n?.key).toBe("notifications.streamHealthDegraded");
		expect(n?.is_persistent).toBe(false);
	});

	it("raises an error toast on any → dead", () => {
		for (const prev of ["healthy", "degraded", "unknown"] as HealthIndicator[]) {
			const n = notificationForTransition(prev, "dead");
			expect(n?.type).toBe("error");
			expect(n?.name).toBe("stream-health-dead");
			expect(n?.key).toBe("notifications.streamHealthDead");
		}
	});

	it("raises a success toast when recovering to healthy from degraded or dead", () => {
		expect(notificationForTransition("degraded", "healthy")?.type).toBe("success");
		expect(notificationForTransition("dead", "healthy")?.name).toBe("stream-health-recovered");
	});

	it("stays silent on the initial unknown → healthy (clean start, no toast)", () => {
		expect(notificationForTransition("unknown", "healthy")).toBeNull();
	});

	it("never alarms when settling into unknown", () => {
		expect(notificationForTransition("healthy", "unknown")).toBeNull();
		expect(notificationForTransition("dead", "unknown")).toBeNull();
	});
});

// ============================================
// Reactive store (ingest → state + transition toasts)
// ============================================

describe("stream-health store (reactive API)", () => {
	beforeEach(() => {
		resetStreamHealth();
		clearNotifications();
	});

	afterEach(() => {
		resetStreamHealth();
		clearNotifications();
	});

	it("starts at `unknown` before any broadcast", () => {
		expect(getStreamHealthState()).toBe("unknown");
		expect(getStreamHealthSnapshot()).toEqual({ current: "unknown", previous: "unknown" });
	});

	it("updates the indicator across healthy → degraded → dead", () => {
		ingestStreamHealth({ state: "healthy" });
		expect(getStreamHealthState()).toBe("healthy");

		ingestStreamHealth({ state: "degraded" });
		expect(getStreamHealthState()).toBe("degraded");

		ingestStreamHealth({ state: "dead" });
		expect(getStreamHealthState()).toBe("dead");
		expect(getStreamHealthSnapshot()).toEqual({ current: "dead", previous: "degraded" });
	});

	it("does not toast on the initial healthy frame, but toasts on the degraded transition", () => {
		ingestStreamHealth({ state: "healthy" });
		expect(getActive()).toHaveLength(0);

		ingestStreamHealth({ state: "degraded" });
		const active = getActive();
		expect(active).toHaveLength(1);
		expect(active[0]?.name).toBe("stream-health-degraded");
		expect(active[0]?.type).toBe("warning");
	});

	it("raises an error toast when dropping to dead", () => {
		ingestStreamHealth({ state: "healthy" });
		ingestStreamHealth({ state: "dead" });
		const dead = getActive().find((n) => n.name === "stream-health-dead");
		expect(dead?.type).toBe("error");
	});

	it("raises a recovery toast when climbing back to healthy", () => {
		ingestStreamHealth({ state: "degraded" });
		ingestStreamHealth({ state: "healthy" });
		const recovered = getActive().find((n) => n.name === "stream-health-recovered");
		expect(recovered?.type).toBe("success");
	});

	it("never crashes and settles on the final state across 20 rapid flaps", () => {
		const cycle: HealthIndicator[] = ["healthy", "degraded", "dead"];
		let last: HealthIndicator = "unknown";
		expect(() => {
			for (let i = 0; i < 20; i++) {
				last = cycle[i % cycle.length];
				ingestStreamHealth({ state: last });
			}
		}).not.toThrow();

		expect(getStreamHealthState()).toBe(last);

		// Dedup-by-name keeps the active toast set bounded (one per target state),
		// not 20 stacked toasts, even under rapid flapping.
		const names = new Set(getActive().map((n) => n.name));
		expect(names.size).toBeLessThanOrEqual(3);
	});

	it("ignores malformed frames without disturbing the last good state or toasting", () => {
		ingestStreamHealth({ state: "degraded" });
		expect(getActive()).toHaveLength(1);

		ingestStreamHealth({ garbage: true });
		ingestStreamHealth(null);
		ingestStreamHealth({ state: "wat" });

		expect(getStreamHealthState()).toBe("degraded");
		expect(getActive()).toHaveLength(1);
	});
});
