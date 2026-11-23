import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import * as emitter from "../modules/events/emit.ts";
import { defaultOnEngineUnreachable } from "../modules/streaming/cerastream-backend.ts";
import {
	buildDefaultPublishEngineAvailability,
	ENGINE_RECONNECT_FLAP_WINDOW_MS,
	ENGINE_RECONNECT_MAX_MS,
	type EngineReconnectLogger,
	initEngineConnection,
	rearmEngineReconnect,
	settleEngineReconnect,
	stopEngineReconnect,
} from "../modules/streaming/engine-reconnect.ts";
import {
	getEngineDeviceCache,
	mergeObservedWithProbe,
	refreshAndBroadcastSources,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import * as compat from "../rpc/compat.ts";

// The engine's watchdog restart after boot: the reconnect loop settled once at
// boot, the session then lost its control connection, and nothing asked the
// engine again, so the snapshot stayed "unavailable" until the backend restarted.

type TimerHandle = ReturnType<typeof setTimeout>;

function harness() {
	let reachable = false;
	/** What the next refresh finds; flipped by the test to move the engine. */
	let engineUp = true;
	let clock = 0;
	let nextHandle = 0;
	const timers = new Map<number, () => void>();
	const delays: number[] = [];
	const cleared: number[] = [];
	const warnings: string[] = [];
	const infos: string[] = [];
	const debugs: string[] = [];
	let refreshes = 0;
	let heals = 0;
	let bootHeals = 0;
	let offline = 0;
	let recovered = 0;
	let gate: Promise<void> | undefined;
	let healGate: Promise<void> | undefined;
	const healSteps: string[] = [];

	const logger: EngineReconnectLogger = {
		debug: (message) => debugs.push(message),
		info: (message) => infos.push(message),
		warn: (message) => warnings.push(message),
	};

	const deps = {
		refreshCapabilities: async () => {
			refreshes += 1;
			// The answer is read when the request goes out; a loss reported while
			// it is in flight must not be hidden by it.
			const answer = engineUp;
			if (gate) await gate;
			reachable = answer;
		},
		isEngineReachable: () => reachable,
		// The boot heal (publishing plus the boot race's session settling).
		broadcastEngineState: () => {
			bootHeals += 1;
		},
		// The heal after a re-arm: publishing only.
		publishEngineAvailability: async (alive: () => boolean) => {
			healSteps.push("publish-start");
			if (healGate) await healGate;
			if (!alive()) return;
			healSteps.push("publish-done");
			heals += 1;
		},
		broadcastEngineOffline: () => {
			offline += 1;
		},
		reportEngineState: () => {},
		onRecovered: () => {
			recovered += 1;
		},
		logger,
		random: () => 0.5,
		now: () => clock,
		setTimer: (fn: () => void, ms: number): TimerHandle => {
			nextHandle += 1;
			timers.set(nextHandle, fn);
			delays.push(ms);
			return nextHandle as unknown as TimerHandle;
		},
		clearTimer: (timer: TimerHandle) => {
			const id = timer as unknown as number;
			cleared.push(id);
			timers.delete(id);
		},
		baseDelayMs: 2_000,
		maxDelayMs: ENGINE_RECONNECT_MAX_MS,
		flapWindowMs: ENGINE_RECONNECT_FLAP_WINDOW_MS,
	};

	return {
		deps,
		/** What `invalidateCapabilities()` does on a proven loss. */
		lose(site = "list-devices-poll") {
			reachable = false;
			rearmEngineReconnect(site);
		},
		setEngineUp(up: boolean) {
			engineUp = up;
		},
		advance(ms: number) {
			clock += ms;
		},
		holdHeal() {
			let release!: () => void;
			healGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				healGate = undefined;
				release();
			};
		},
		holdRefresh() {
			let release!: () => void;
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				gate = undefined;
				release();
			};
		},
		/** Run the one pending timer, as the event loop would after its delay. */
		fire() {
			const [first] = timers.entries();
			if (!first) throw new Error("no pending timer");
			const [id, fn] = first;
			timers.delete(id);
			advance(delays.at(-1) ?? 0);
			fn();
			return settleEngineReconnect();
		},
		get pending() {
			return timers.size;
		},
		get delays() {
			return delays;
		},
		get cleared() {
			return cleared;
		},
		get refreshes() {
			return refreshes;
		},
		get heals() {
			return heals;
		},
		get bootHeals() {
			return bootHeals;
		},
		get recovered() {
			return recovered;
		},
		healSteps,
		debugs,
		get offline() {
			return offline;
		},
		get reachable() {
			return reachable;
		},
		warnings,
		infos,
	};

	function advance(ms: number) {
		clock += ms;
	}
}

async function bootedReachable() {
	const h = harness();
	await initEngineConnection(h.deps);
	expect(h.reachable).toBe(true);
	expect(h.pending).toBe(0);
	return h;
}

// Boot-loss and signal cases would otherwise reach the real event store and
// leave its coalescing timers behind.
let emitSpy: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
	emitSpy = spyOn(emitter, "emitEvent").mockImplementation(() => {});
});

afterEach(() => {
	stopEngineReconnect();
	emitSpy?.mockRestore();
	emitter.resetEventEmitterForTest();
});

describe("rearmEngineReconnect: drop and recovery", () => {
	test("a loss after boot is rechecked until the engine answers, then clients are healed", async () => {
		const h = await bootedReachable();
		h.advance(120_000);

		h.setEngineUp(false);
		h.lose();
		// Clients that stay connected learn the engine is gone.
		expect(h.offline).toBe(1);
		expect(h.pending).toBe(1);
		expect(h.delays.at(-1)).toBe(1_500); // starts again at the base delay
		expect(h.warnings.some((w) => w.includes("list-devices-poll"))).toBe(true);

		// Still restarting on the first recheck.
		await h.fire();
		expect(h.heals).toBe(0);
		expect(h.pending).toBe(1);
		expect(h.offline).toBe(1); // once per outage, not per recheck

		// systemd brought it back.
		h.setEngineUp(true);
		await h.fire();
		expect(h.reachable).toBe(true);
		expect(h.heals).toBe(1);
		expect(h.pending).toBe(0);
		expect(h.infos.some((i) => /engine back after \d+s/.test(i))).toBe(true);
	});

	test("every later loss re-arms the loop again", async () => {
		const h = await bootedReachable();
		for (let round = 1; round <= 3; round++) {
			h.advance(5 * ENGINE_RECONNECT_FLAP_WINDOW_MS);
			h.lose();
			expect(h.pending).toBe(1);
			await h.fire();
			expect(h.heals).toBe(round);
			expect(h.pending).toBe(0);
		}
		expect(h.offline).toBe(3);
	});

	test("a start that could not reach the engine re-arms it too, and an engine still up just settles", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		// No session held a connection, so the snapshot was never invalidated.
		rearmEngineReconnect("start");
		expect(h.offline).toBe(0); // the snapshot still reads reachable
		expect(h.pending).toBe(1);
		await h.fire();
		expect(h.heals).toBe(1);
		expect(h.pending).toBe(0);
	});

	test("a start that could not reach an engine that is really gone shows it offline", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		rearmEngineReconnect("start");
		await h.fire();
		expect(h.reachable).toBe(false);
		expect(h.offline).toBe(1);
		expect(h.pending).toBe(1);
	});
});

describe("rearmEngineReconnect: engine absent for a long time", () => {
	test("backoff caps at the ceiling, one timer at a time, no extra broadcasts", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		h.lose();
		for (let i = 0; i < 40; i++) {
			await h.fire();
			expect(h.pending).toBe(1);
		}
		// 0.75 × min(2000·2^n, 30000) with random()=0.5
		expect(h.delays.slice(-41, -35)).toEqual([
			1_500, 3_000, 6_000, 12_000, 22_500, 22_500,
		]);
		expect(Math.max(...h.delays)).toBeLessThanOrEqual(ENGINE_RECONNECT_MAX_MS);
		expect(h.refreshes).toBe(41); // boot + 40 rechecks, nothing in between
		expect(h.offline).toBe(1);
		expect(h.heals).toBe(0);

		// A loss reported again during the outage does not stack a second timer
		// or restart the backoff.
		const before = h.delays.length;
		h.lose("change-config");
		expect(h.pending).toBe(1);
		expect(h.delays.length).toBe(before);

		h.setEngineUp(true);
		await h.fire();
		expect(h.heals).toBe(1);
		expect(h.pending).toBe(0);
	});
});

describe("rearmEngineReconnect: flapping engine", () => {
	test("a loss soon after a heal keeps the previous backoff; a quiet minute resets it", async () => {
		const h = await bootedReachable();
		h.advance(120_000);

		// First crash: base delay, engine down for two rechecks.
		h.setEngineUp(false);
		h.lose();
		expect(h.delays.at(-1)).toBe(1_500);
		await h.fire();
		await h.fire();
		h.setEngineUp(true);
		await h.fire();
		expect(h.heals).toBe(1);

		// Crashes again right away: the next recheck waits longer, not 1.5 s.
		h.advance(5_000);
		h.lose();
		expect(h.delays.at(-1)).toBe(12_000);
		expect(h.warnings.at(-1)).toContain("previous backoff");
		await h.fire();
		expect(h.heals).toBe(2);

		// And again: still slower, capped.
		h.advance(5_000);
		h.lose();
		expect(h.delays.at(-1)).toBe(22_500);
		await h.fire();
		expect(h.heals).toBe(3);

		// Stable for longer than the flap window: back to the base delay.
		h.advance(ENGINE_RECONNECT_FLAP_WINDOW_MS + 1);
		h.lose();
		expect(h.delays.at(-1)).toBe(1_500);
	});
});

describe("rearmEngineReconnect: first loss soon after boot", () => {
	test("is not taken for a flap: it starts at the base delay", async () => {
		const h = await bootedReachable();
		h.advance(5_000);
		h.lose();
		expect(h.delays.at(-1)).toBe(1_500);
		expect(h.warnings.at(-1)).not.toContain("previous backoff");
	});
});

describe("rearmEngineReconnect: loss during an attempt (reconnect during a Start)", () => {
	test("an attempt that read the engine before it went away does not settle", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		h.lose();

		// The engine is back for this refresh, but a Start that dials it while
		// the refresh is in flight finds it gone again.
		h.setEngineUp(true);
		const release = h.holdRefresh();
		const tick = h.fire();
		h.setEngineUp(false);
		h.lose("start");
		release();
		await tick;

		expect(h.pending).toBe(1); // still reconnecting, not settled
		// The stale answer is not published and no recovery is reported.
		expect(h.healSteps).toEqual([]);
		expect(h.recovered).toBe(0);
		expect(h.offline).toBe(1);

		// The refresh stored that stale answer, so a page connecting meanwhile
		// read the engine as available; the next recheck that finds it gone
		// tells the clients again.
		await h.fire();
		expect(h.offline).toBe(2);
		expect(h.pending).toBe(1);

		h.setEngineUp(true);
		await h.fire();
		expect(h.pending).toBe(0);
		expect(h.reachable).toBe(true);
		expect(h.heals).toBe(1);
	});

	test("a loss while the heal publishes skips the rest and reports no recovery", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.lose();

		// A Start finds the engine gone while the heal is publishing. That path
		// leaves the capability snapshot as it was.
		const release = h.holdHeal();
		const tick = h.fire();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(h.healSteps).toEqual(["publish-start"]);
		rearmEngineReconnect("start");
		release();
		await tick;

		expect(h.healSteps).toEqual(["publish-start"]);
		expect(h.heals).toBe(0);
		expect(h.recovered).toBe(0);
		expect(h.pending).toBe(1); // still reconnecting, not settled
		expect(
			h.warnings.some((w) => w.includes("lost again during the recheck")),
		).toBe(true);
	});

	test("a loss while the boot attempt is in flight is not taken as reachable", async () => {
		const h = harness();
		const reports: boolean[] = [];
		const release = h.holdRefresh();
		const boot = initEngineConnection({
			...h.deps,
			reportEngineState: (reachable: boolean) => {
				reports.push(reachable);
			},
		});
		rearmEngineReconnect("list-devices-poll");
		release();
		await boot;
		expect(h.pending).toBe(1);
		// The stale answer never reaches the engine-state reporter either.
		expect(reports).toEqual([]);
	});
});

describe("rearmEngineReconnect: shutdown", () => {
	test("shutting down while reconnecting clears the timer and nothing runs after", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		h.lose();
		expect(h.pending).toBe(1);

		stopEngineReconnect();
		expect(h.pending).toBe(0);
		expect(h.cleared.length).toBe(1);

		// A loss reported during teardown starts nothing.
		const refreshes = h.refreshes;
		rearmEngineReconnect("list-devices-poll");
		expect(h.pending).toBe(0);
		expect(h.refreshes).toBe(refreshes);
	});

	test("shutting down during an in-flight recheck does not heal or reschedule", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.lose();
		const release = h.holdRefresh();
		const tick = h.fire();
		stopEngineReconnect();
		release();
		await tick;
		expect(h.heals).toBe(0);
		expect(h.pending).toBe(0);
	});

	test("a loss before the boot attempt ever ran starts nothing", async () => {
		stopEngineReconnect();
		rearmEngineReconnect("start");
		// The boot path then owns the first attempt, undisturbed: one refresh,
		// nothing scheduled, no offline broadcast left over from the early loss.
		const h = harness();
		await initEngineConnection(h.deps);
		expect(h.refreshes).toBe(1);
		expect(h.pending).toBe(0);
		expect(h.offline).toBe(0);
	});

	test("shutting down during a heal skips its remaining steps and the recovery report", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.lose();
		const release = h.holdHeal();
		const tick = h.fire();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(h.healSteps).toEqual(["publish-start"]);
		stopEngineReconnect();
		release();
		await tick;
		expect(h.healSteps).toEqual(["publish-start"]);
		expect(h.heals).toBe(0);
		expect(h.recovered).toBe(0);
		expect(h.pending).toBe(0);
	});

	test("SIGTERM and SIGINT stop the loop: handleTerminationSignal runs it, main.ts passes it", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.lose();
		expect(h.pending).toBe(1);
		try {
			handleTerminationSignal("SIGTERM", {
				stopEngineReconnect,
				stopSrtIngest: async () => {},
				stopDmesgWatchers: () => {},
				gracefulShutdown: async () => {},
				exit: () => {},
			});
			// Synchronous, before any async cleanup starts.
			expect(h.pending).toBe(0);
			expect(h.cleared.length).toBe(1);
		} finally {
			resetShutdownForTest();
		}
		const main = readFileSync(resolve(import.meta.dir, "../main.ts"), "utf8");
		for (const signal of ["SIGTERM", "SIGINT"]) {
			const call = main.slice(
				main.indexOf(`handleTerminationSignal("${signal}"`),
				main.indexOf("exit: process.exit", main.indexOf(`"${signal}"`)),
			);
			expect(call, signal).toContain("stopEngineReconnect,");
		}
	});
});

describe("heal after a re-arm: publishing only", () => {
	test("the boot heal settles the boot race; a heal after a re-arm only publishes", async () => {
		const h = harness();
		h.setEngineUp(false);
		await initEngineConnection(h.deps);
		h.setEngineUp(true);
		await h.fire();
		expect(h.bootHeals).toBe(1);
		expect(h.heals).toBe(0);

		h.advance(5 * ENGINE_RECONNECT_FLAP_WINDOW_MS);
		h.lose();
		await h.fire();
		expect(h.bootHeals).toBe(1);
		expect(h.heals).toBe(1);
	});

	test("a loss while the boot loop still runs keeps the boot heal", async () => {
		const h = harness();
		h.setEngineUp(false);
		await initEngineConnection(h.deps);
		h.lose();
		h.setEngineUp(true);
		await h.fire();
		expect(h.bootHeals).toBe(1);
		expect(h.heals).toBe(0);
	});

	test("the default publisher sends capabilities, pipelines and sources, and stops when torn down", async () => {
		const calls: string[] = [];
		const passed: Array<() => boolean> = [];
		const steps = {
			resolveHardware: async () => {
				calls.push("hardware");
			},
			broadcastCapabilities: () => {
				calls.push("capabilities");
			},
			broadcastPipelines: () => {
				calls.push("pipelines");
			},
			refreshSources: async (_deps: unknown, alive: () => boolean) => {
				passed.push(alive);
				calls.push(alive() ? "sources" : "sources-after-teardown");
			},
		};
		const guard = () => true;
		await buildDefaultPublishEngineAvailability(undefined, steps)(guard);
		expect(calls).toEqual(["hardware", "capabilities", "pipelines", "sources"]);
		expect(passed).toEqual([guard]);

		calls.length = 0;
		let alive = true;
		const publish = buildDefaultPublishEngineAvailability(undefined, {
			...steps,
			resolveHardware: async () => {
				calls.push("hardware");
				alive = false; // torn down while the hardware kind resolves
			},
		});
		await publish(() => alive);
		expect(calls).toEqual(["hardware"]);
	});
});

describe("rearmEngineReconnect: logging during a long outage", () => {
	test("rechecks log at info until the backoff caps, once more at the cap, then at debug", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		h.lose();
		for (let i = 0; i < 20; i++) await h.fire();
		const rechecks = h.infos.filter((m) => m.includes("rechecking engine in"));
		// 1.5 s, 3 s, 6 s, 12 s, then the first capped one.
		expect(rechecks.length).toBe(5);
		expect(rechecks.at(-1)).toContain("until it answers");
		expect(
			h.debugs.filter((m) => m.includes("rechecking engine in")).length,
		).toBe(16);
	});
});

describe("default wiring of a proven loss", () => {
	test("defaultOnEngineUnreachable re-arms the running loop", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		await defaultOnEngineUnreachable("list-devices-poll");
		expect(h.pending).toBe(1);
		expect(h.warnings.some((w) => w.includes("list-devices-poll"))).toBe(true);
	});
});

describe("sources after teardown", () => {
	const hdmi = {
		input_id: "video0",
		device_path: "/dev/video0",
		display_name: "HDMI",
		media_class: "video" as const,
		kind: "hdmi" as const,
		caps: [
			{
				width: 1920,
				height: 1080,
				framerate: "60/1",
				media_type: "video/x-raw",
			},
		],
	};

	test("the default publisher hands its guard to the real sources refresh", async () => {
		resetEngineDeviceCache();
		const sent = spyOn(compat, "broadcastMsg");
		try {
			let alive = true;
			const publish = buildDefaultPublishEngineAvailability(
				{
					fetchEngineDevices: async () => {
						alive = false; // torn down while the probe was in flight
						return { devices: [hdmi] };
					},
				},
				// Only the hardware and capability steps are stubbed; sources is real.
				{
					resolveHardware: async () => {},
					broadcastCapabilities: () => {},
					broadcastPipelines: () => {},
				},
			);
			await publish(() => alive);
			expect(getEngineDeviceCache()).toEqual([]);
			expect(sent.mock.calls.filter(([type]) => type === "sources")).toEqual(
				[],
			);
		} finally {
			sent.mockRestore();
			resetEngineDeviceCache();
		}
	});

	test("a teardown during the device probe commits and broadcasts nothing", async () => {
		resetEngineDeviceCache();
		const sent = spyOn(compat, "broadcastMsg");
		try {
			let alive = true;
			await refreshAndBroadcastSources(
				{
					fetchEngineDevices: async () => {
						alive = false; // torn down while the probe was in flight
						return { devices: [hdmi] };
					},
				},
				() => alive,
			);
			expect(getEngineDeviceCache()).toEqual([]);
			expect(sent.mock.calls.filter(([type]) => type === "sources")).toEqual(
				[],
			);
			// Nor are its identities kept for a later failed probe to fall back on.
			const observed = {
				input_id: "video0",
				device_path: "/dev/video0",
				display_name: "HDMI",
				media_class: "video" as const,
				kind: "usb" as const,
			};
			expect(mergeObservedWithProbe([observed], [])[0]?.kind).toBe("usb");

			// Control: the same probe with the loop alive commits and publishes.
			await refreshAndBroadcastSources(
				{ fetchEngineDevices: async () => ({ devices: [hdmi] }) },
				() => true,
			);
			expect(getEngineDeviceCache()).toHaveLength(1);
			expect(
				sent.mock.calls.filter(([type]) => type === "sources").length,
			).toBe(1);
			expect(mergeObservedWithProbe([observed], [])[0]?.kind).toBe("hdmi");
		} finally {
			sent.mockRestore();
			resetEngineDeviceCache();
		}
	});
});

describe("production binding of a start that cannot reach the engine", () => {
	test("streamSessionProductionDeps.onEngineUnavailable re-arms the running loop", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		streamSessionProductionDeps.onEngineUnavailable?.();
		for (let i = 0; i < 20 && h.pending === 0; i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(h.pending).toBe(1);
		expect(h.warnings.some((w) => w.includes("(start)"))).toBe(true);
	});
});
