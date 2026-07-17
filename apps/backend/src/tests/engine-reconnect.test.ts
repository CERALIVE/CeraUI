import { afterEach, describe, expect, test } from "bun:test";
import { CerastreamConnectionError } from "@ceralive/cerastream";
import {
	clearCapabilitiesCache,
	getLastCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	backoffDelay,
	ENGINE_RECONNECT_MAX_MS,
	type EngineReconnectLogger,
	initEngineConnection,
	settleEngineReconnect,
	stopEngineReconnect,
} from "../modules/streaming/engine-reconnect.ts";

const silent: EngineReconnectLogger = { info: () => {}, warn: () => {} };

type TimerHandle = ReturnType<typeof setTimeout>;

// A controllable environment: a manual timer queue plus a scripted list of
// per-attempt reachability outcomes, so the whole loop is driven deterministically
// with no real time. `fireNextTimer` runs the one pending timer then awaits the
// background attempt it kicks off (via the settle seam).
function harness(outcomes: boolean[], broadcastThrowsFirst = 0) {
	const timers: Array<{ fn: () => void }> = [];
	let idx = 0;
	let reachable = false;
	const refreshCalls: boolean[] = [];
	let broadcasts = 0;
	let broadcastAttempts = 0;
	const delays: number[] = [];

	const deps = {
		refreshCapabilities: async () => {
			reachable = outcomes[Math.min(idx, outcomes.length - 1)] ?? false;
			idx += 1;
			refreshCalls.push(reachable);
		},
		isEngineReachable: () => reachable,
		broadcastEngineState: () => {
			broadcastAttempts += 1;
			if (broadcastAttempts <= broadcastThrowsFirst) {
				throw new Error("heal broadcast failed (test)");
			}
			broadcasts += 1;
		},
		logger: silent,
		random: () => 0.5,
		setTimer: (fn: () => void, ms: number): TimerHandle => {
			delays.push(ms);
			timers.push({ fn });
			return timers.length as unknown as TimerHandle;
		},
		clearTimer: () => {},
		baseDelayMs: 2_000,
		maxDelayMs: ENGINE_RECONNECT_MAX_MS,
	};

	return {
		deps,
		get pendingTimers() {
			return timers.length;
		},
		get refreshCount() {
			return refreshCalls.length;
		},
		get broadcasts() {
			return broadcasts;
		},
		get broadcastAttempts() {
			return broadcastAttempts;
		},
		get delays() {
			return delays;
		},
		async fireNextTimer() {
			const t = timers.shift();
			if (!t) throw new Error("no pending timer to fire");
			t.fn();
			await settleEngineReconnect();
		},
	};
}

afterEach(() => {
	stopEngineReconnect();
	clearCapabilitiesCache();
});

describe("backoffDelay", () => {
	test("equal-jitter window, capped at the ceiling", () => {
		// attempt 0: cap=2000 → [1000, 2000]; random()=0 → 1000, random()~1 → ~2000
		expect(backoffDelay(0, 2_000, 30_000, () => 0)).toBe(1_000);
		expect(backoffDelay(0, 2_000, 30_000, () => 0.5)).toBe(1_500);
		// large attempt caps at max: cap=30000 → [15000, 30000]
		expect(backoffDelay(20, 2_000, 30_000, () => 0)).toBe(15_000);
		expect(backoffDelay(20, 2_000, 30_000, () => 0.999)).toBeLessThanOrEqual(
			30_000,
		);
	});
});

describe("initEngineConnection — reachable at boot", () => {
	test("no reconnect loop is armed when the first attempt succeeds", async () => {
		const h = harness([true]);
		await initEngineConnection(h.deps);

		expect(h.refreshCount).toBe(1);
		expect(h.pendingTimers).toBe(0);
		expect(h.broadcasts).toBe(0);
	});
});

describe("initEngineConnection — (a) boot retry within the boot window", () => {
	test("a failed boot attempt followed by a successful retry heals + settles", async () => {
		const h = harness([false, true]);
		await initEngineConnection(h.deps);

		// boot attempt failed → one recheck scheduled, no heal broadcast yet.
		expect(h.refreshCount).toBe(1);
		expect(h.pendingTimers).toBe(1);
		expect(h.broadcasts).toBe(0);

		// the scheduled retry succeeds → heal broadcast fires once, loop settles.
		await h.fireNextTimer();
		expect(h.refreshCount).toBe(2);
		expect(h.broadcasts).toBe(1);
		expect(h.pendingTimers).toBe(0);
	});
});

describe("initEngineConnection — (b) later out-of-band reconnect", () => {
	test("several failed rechecks then a later success still heals + settles", async () => {
		const h = harness([false, false, false, false, true]);
		await initEngineConnection(h.deps);

		// three background rechecks, all still down: keep rescheduling, never heal.
		await h.fireNextTimer();
		await h.fireNextTimer();
		await h.fireNextTimer();
		expect(h.broadcasts).toBe(0);
		expect(h.pendingTimers).toBe(1);

		// the fourth recheck finds the engine up → heal + settle.
		await h.fireNextTimer();
		expect(h.broadcasts).toBe(1);
		expect(h.pendingTimers).toBe(0);
	});

	test("backoff escalates then caps at the ceiling (periodic recheck)", async () => {
		const h = harness([false, false, false, false, false, false]);
		await initEngineConnection(h.deps);
		for (let i = 0; i < 5; i++) await h.fireNextTimer();

		// random()=0.5 → delay = cap/2 + 0.5*cap/2 = 0.75*cap.
		// caps: 2000,4000,8000,16000,30000(capped),30000 → 0.75× each.
		expect(h.delays.slice(0, 6)).toEqual([
			1_500, 3_000, 6_000, 12_000, 22_500, 22_500,
		]);
	});
});

describe("initEngineConnection — (d) heal broadcast retried until it completes", () => {
	test("a reachable engine whose first heal broadcast throws keeps retrying, then settles once it succeeds", async () => {
		// engine is DOWN at boot, then UP on both rechecks; the first heal broadcast
		// throws (a transient broadcast-collaborator error), the second succeeds.
		const h = harness([false, true, true], 1);
		await initEngineConnection(h.deps);

		// boot attempt failed → one recheck scheduled, nothing broadcast yet.
		expect(h.pendingTimers).toBe(1);
		expect(h.broadcasts).toBe(0);

		// first recheck: engine reachable, but the heal broadcast THROWS. The loop
		// must NOT settle on this — it reschedules so clients are not stranded on the
		// offline banner while the engine is actually healthy.
		await h.fireNextTimer();
		expect(h.broadcastAttempts).toBe(1);
		expect(h.broadcasts).toBe(0);
		expect(h.pendingTimers).toBe(1);

		// second recheck: the heal broadcast succeeds → clients receive the full
		// capabilities/pipelines/sources re-broadcast → the loop finally settles.
		await h.fireNextTimer();
		expect(h.broadcastAttempts).toBe(2);
		expect(h.broadcasts).toBe(1);
		expect(h.pendingTimers).toBe(0);
	});
});

describe("initEngineConnection — (c) permanently unavailable (real ladder)", () => {
	test("engineUnavailable/engineStarting persist and the loop never falsely heals", async () => {
		clearCapabilitiesCache();
		let broadcasts = 0;
		const timers: Array<{ fn: () => void }> = [];

		// The REAL initPipelines + default isEngineReachable (getLastCapabilities),
		// with a throwing engine fetcher — exactly the engine-starting/unavailable
		// mock-scenario semantics. Only the timer + broadcast + logger are stubbed.
		await initEngineConnection({
			capabilities: {
				fetchEngineCapabilities: async () => {
					throw new CerastreamConnectionError("engine down (test)");
				},
				fetchEngineDevices: async () => ({ devices: [] }),
			},
			broadcastEngineState: () => {
				broadcasts += 1;
			},
			logger: silent,
			random: () => 0.5,
			setTimer: (fn) => {
				timers.push({ fn });
				return timers.length as unknown as TimerHandle;
			},
			clearTimer: () => {},
		});

		// The empty-cache floor: minimal safe set flagged unavailable + starting.
		expect(getLastCapabilities()?.engineUnavailable).toBe(true);
		expect(getLastCapabilities()?.engineStarting).toBe(true);
		// a background recheck is scheduled; nothing was falsely broadcast as healed.
		expect(timers.length).toBe(1);
		expect(broadcasts).toBe(0);

		// fire a couple of rechecks: still down, still no false heal.
		for (let i = 0; i < 2; i++) {
			const t = timers.shift();
			t?.fn();
			await settleEngineReconnect();
		}
		expect(broadcasts).toBe(0);
		expect(getLastCapabilities()?.engineUnavailable).toBe(true);
	});

	test("a live engine on a later attempt heals through the real ladder", async () => {
		clearCapabilitiesCache();
		let broadcasts = 0;
		const timers: Array<{ fn: () => void }> = [];
		let up = false;

		await initEngineConnection({
			// refreshCapabilities routes through the REAL initPipelines so the default
			// isEngineReachable (getLastCapabilities) is exercised end-to-end.
			capabilities: {
				fetchEngineCapabilities: async () => {
					if (!up) throw new CerastreamConnectionError("engine down (test)");
					return {
						caps: {
							platform: {
								supports_h265: false,
								hardware_accelerated: false,
								max_resolution: "1920x1080",
							},
							encoder: {
								codecs: ["H264"],
								bitrate_range: { min: 500, max: 6000, unit: "kbps" },
							},
							sources: [
								{
									id: "hdmi",
									supports_audio: true,
									supports_resolution_override: true,
									supports_framerate_override: true,
									default_resolution: "1920x1080",
									default_framerate: 60,
								},
							],
						},
						schemaVersion: (await import("@ceralive/cerastream"))
							.SCHEMA_VERSION,
					};
				},
				fetchEngineDevices: async () => ({ devices: [] }),
			},
			broadcastEngineState: () => {
				broadcasts += 1;
			},
			logger: silent,
			random: () => 0.5,
			setTimer: (fn) => {
				timers.push({ fn });
				return timers.length as unknown as TimerHandle;
			},
			clearTimer: () => {},
		});

		expect(getLastCapabilities()?.engineUnavailable).toBe(true);
		expect(broadcasts).toBe(0);

		// engine comes up; the next recheck sees a live snapshot → heal + settle.
		up = true;
		const t = timers.shift();
		t?.fn();
		await settleEngineReconnect();

		expect(getLastCapabilities()?.engineUnavailable).toBe(false);
		expect(getLastCapabilities()?.sources.some((s) => s.id === "hdmi")).toBe(
			true,
		);
		expect(broadcasts).toBe(1);
		expect(timers.length).toBe(0);
	});
});

describe("stopEngineReconnect — teardown", () => {
	test("is idempotent and halts a pending recheck", async () => {
		const h = harness([false, false]);
		await initEngineConnection(h.deps);
		expect(h.pendingTimers).toBe(1);

		stopEngineReconnect();
		stopEngineReconnect();

		// firing a stale captured timer after teardown is a no-op (no refresh).
		const before = h.refreshCount;
		await settleEngineReconnect();
		expect(h.refreshCount).toBe(before);
	});
});
