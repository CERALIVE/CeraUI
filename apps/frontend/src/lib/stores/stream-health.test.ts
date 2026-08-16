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
 * the store resolves messages from a plain tree rather than evaluating the adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ceraui/i18n/svelte", () => ({ m: {} }));

import { clearNotifications, getActive } from "./notifications.svelte";
import {
	getStreamHealthSnapshot,
	getStreamHealthState,
	type HealthIndicator,
	type HealthRollup,
	type HealthSnapshot,
	ingestStreamHealth,
	initialHealthSnapshot,
	isVideoSignalLost,
	notificationForTransition,
	parseHealthRollup,
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
		expect(parseHealthState({ state: "idle" })).toBe("idle");
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
		for (const prev of [
			"healthy",
			"degraded",
			"unknown",
		] as HealthIndicator[]) {
			const n = notificationForTransition(prev, "dead");
			expect(n?.type).toBe("error");
			expect(n?.name).toBe("stream-health-dead");
			expect(n?.key).toBe("notifications.streamHealthDead");
		}
	});

	it("raises a success toast when recovering to healthy from degraded or dead", () => {
		expect(notificationForTransition("degraded", "healthy")?.type).toBe(
			"success",
		);
		expect(notificationForTransition("dead", "healthy")?.name).toBe(
			"stream-health-recovered",
		);
	});

	it("stays silent on the initial unknown → healthy (clean start, no toast)", () => {
		expect(notificationForTransition("unknown", "healthy")).toBeNull();
	});

	it("never alarms when settling into unknown", () => {
		expect(notificationForTransition("healthy", "unknown")).toBeNull();
		expect(notificationForTransition("dead", "unknown")).toBeNull();
	});

	it("never alarms on idle — stopping a stream is not a failure", () => {
		expect(notificationForTransition("healthy", "idle")).toBeNull();
		expect(notificationForTransition("degraded", "idle")).toBeNull();
		expect(notificationForTransition("dead", "idle")).toBeNull();
		expect(notificationForTransition("idle", "healthy")).toBeNull();
	});
});

// ============================================
// Cause-specific degraded copy (Wave H: "still not seeing signal loss")
// ============================================

describe("notificationForTransition — names the cause behind `degraded`", () => {
	it("says NO VIDEO, not merely 'degraded', for the frames reason", () => {
		// The exact reason health.ts `deriveReason()` emits on real signal loss.
		const n = notificationForTransition("healthy", "degraded", {
			component: "frames",
			detail: "No frames advancing",
		});
		expect(n?.key).toBe("notifications.streamHealthNoVideo");
		expect(n?.key).not.toBe("notifications.streamHealthDegraded");
	});

	it("distinguishes a bonded-link degradation from a video one", () => {
		const n = notificationForTransition("healthy", "degraded", {
			component: "links",
			detail: "1 of 3 links down",
		});
		expect(n?.key).toBe("notifications.streamHealthLinksDegraded");
	});

	it("keeps ONE toast name across causes so a frames→links flap replaces, never stacks", () => {
		const frames = notificationForTransition("healthy", "degraded", {
			component: "frames",
			detail: "No frames advancing",
		});
		const links = notificationForTransition("healthy", "degraded", {
			component: "links",
			detail: "1 of 3 links down",
		});
		expect(frames?.name).toBe("stream-health-degraded");
		expect(links?.name).toBe(frames?.name);
	});

	it("falls back to the generic wording for an absent or unknown component", () => {
		expect(notificationForTransition("healthy", "degraded")?.key).toBe(
			"notifications.streamHealthDegraded",
		);
		expect(
			notificationForTransition("healthy", "degraded", {
				component: "some-future-subsystem",
				detail: "…",
			})?.key,
		).toBe("notifications.streamHealthDegraded");
	});

	it("leaves the dead and recovered toasts untouched by a reason", () => {
		const dead = notificationForTransition("degraded", "dead", {
			component: "process",
			detail: "Streaming process not running",
		});
		expect(dead?.key).toBe("notifications.streamHealthDead");
		expect(
			notificationForTransition("degraded", "healthy", undefined)?.key,
		).toBe("notifications.streamHealthRecovered");
	});
});

// ============================================
// isVideoSignalLost — the mid-stream dead-air predicate
// ============================================

function rollup(overrides: Partial<HealthRollup> = {}): HealthRollup {
	return {
		state: "degraded",
		process: { alive: true },
		frames: { advancing: false, count: 30415 },
		srt: { reconnecting: false, reconnectCount: 0 },
		bond: { linkCount: 2, activeLinks: 2 },
		...overrides,
	};
}

describe("isVideoSignalLost", () => {
	it("reports the real board case: degraded with a frozen frame counter", () => {
		expect(isVideoSignalLost(rollup())).toBe(true);
	});

	it("reports it on a dead rollup too", () => {
		expect(isVideoSignalLost(rollup({ state: "dead" }))).toBe(true);
	});

	it("never contradicts a healthy or idle dot beside it", () => {
		expect(
			isVideoSignalLost(
				rollup({ state: "healthy", frames: { advancing: false, count: 1 } }),
			),
		).toBe(false);
		expect(
			isVideoSignalLost(
				rollup({ state: "idle", frames: { advancing: false, count: null } }),
			),
		).toBe(false);
	});

	it("stays silent on an UNKNOWN frame reading — null is not an outage", () => {
		// The cold-start branch: no frame telemetry yet this window. Alarming here
		// would fire a dead-air banner on every stream start.
		expect(
			isVideoSignalLost(rollup({ frames: { advancing: null, count: null } })),
		).toBe(false);
	});

	it("stays silent while frames are genuinely advancing (a link-only degradation)", () => {
		expect(
			isVideoSignalLost(
				rollup({
					frames: { advancing: true, count: 900 },
					bond: { linkCount: 3, activeLinks: 2 },
				}),
			),
		).toBe(false);
	});

	it("stays silent before the first broadcast", () => {
		expect(isVideoSignalLost(null)).toBe(false);
	});
});

// ============================================
// parseHealthRollup — tri-state null preservation
// ============================================

describe("parseHealthRollup", () => {
	it("preserves an explicit null (idle / unknown) — never coerces to false", () => {
		const rollup = parseHealthRollup({
			state: "idle",
			process: { alive: null },
			frames: { advancing: null, count: null },
			srt: { reconnecting: null, reconnectCount: 0 },
			bond: { linkCount: 0, activeLinks: 0 },
		});
		expect(rollup?.state).toBe("idle");
		expect(rollup?.process.alive).toBeNull();
		expect(rollup?.frames.advancing).toBeNull();
		expect(rollup?.frames.count).toBeNull();
		expect(rollup?.srt.reconnecting).toBeNull();
	});

	it("renders each of the three tri-state srt.reconnecting inputs", () => {
		for (const value of [true, false, null]) {
			const rollup = parseHealthRollup({
				state: "healthy",
				process: { alive: true },
				frames: { advancing: true, count: 10 },
				srt: { reconnecting: value, reconnectCount: 0 },
				bond: { linkCount: 1, activeLinks: 1 },
			});
			expect(rollup?.srt.reconnecting).toBe(value);
		}
	});

	it("collapses a missing / non-boolean flag to false, but keeps a real observation", () => {
		const rollup = parseHealthRollup({
			state: "degraded",
			process: { alive: true },
			frames: { advancing: false, count: 5 },
			srt: { reconnectCount: 0 },
			bond: { linkCount: 2, activeLinks: 1 },
		});
		expect(rollup?.process.alive).toBe(true);
		expect(rollup?.frames.advancing).toBe(false);
		// Missing (not null) collapses to false, not null.
		expect(rollup?.srt.reconnecting).toBe(false);
	});

	it("returns null for an unrecognised state so the consumer keeps its last rollup", () => {
		expect(parseHealthRollup({ state: "wat" })).toBeNull();
		expect(parseHealthRollup(null)).toBeNull();
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
		expect(getStreamHealthSnapshot()).toEqual({
			current: "unknown",
			previous: "unknown",
		});
	});

	it("updates the indicator across healthy → degraded → dead", () => {
		ingestStreamHealth({ state: "healthy" });
		expect(getStreamHealthState()).toBe("healthy");

		ingestStreamHealth({ state: "degraded" });
		expect(getStreamHealthState()).toBe("degraded");

		ingestStreamHealth({ state: "dead" });
		expect(getStreamHealthState()).toBe("dead");
		expect(getStreamHealthSnapshot()).toEqual({
			current: "dead",
			previous: "degraded",
		});
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
		const recovered = getActive().find(
			(n) => n.name === "stream-health-recovered",
		);
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
