import { afterEach, describe, expect, test } from "bun:test";
import type {
	CerastreamClient,
	EventHandler,
	EventParams,
	Subscription,
} from "@ceralive/cerastream";
import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import {
	type AudioMeterBridgeDeps,
	type AudioMeterBridgeLogger,
	alsaCardKey,
	initAudioMeterBridge,
	isForeignCardLevel,
	settleAudioMeterBridge,
	stopAudioMeterBridge,
	syncAudioMeterPreference,
	toAudioLevelMessage,
} from "../modules/streaming/audio-meter-bridge.ts";
import { supportsMeterDevicePreference } from "../modules/streaming/cerastream-backend.ts";

const silent: AudioMeterBridgeLogger = {
	info: () => {},
	warn: () => {},
	debug: () => {},
};

type TimerHandle = ReturnType<typeof setTimeout>;

// A fake engine: `connect` either throws (engine down) or resolves a client whose
// `subscribeEvents` captures the handler so the test can push events by hand. The
// manual timer queue drives the boot-retry loop with no real time.
function harness(connectOutcomes: boolean[], schemaVersion = "0.9.0") {
	const timers: Array<{ fn: () => void }> = [];
	let idx = 0;
	let handler: EventHandler | undefined;
	let subscriptionClosed = false;
	let clientClosed = false;
	let subscribedTopics: readonly string[] | undefined;
	const broadcasts: AudioLevelMessage[] = [];

	const reloads: unknown[] = [];
	let preference: string | null = "hw:CARD=usbaudio";
	let reloadRejects = false;

	const subscription: Subscription = {
		result: { topics: ["audio-level"] },
		close: () => {
			subscriptionClosed = true;
		},
	};
	const client: CerastreamClient = {
		subscribeEvents: async (params, h) => {
			subscribedTopics = params.topics;
			handler = h;
			return subscription;
		},
		close: async () => {
			clientClosed = true;
		},
		hello: { schema_version: schemaVersion },
		rawRequest: async (_method: string, params?: unknown) => {
			if (reloadRejects) throw new Error("reload refused (test)");
			reloads.push(params);
			return {};
		},
		// biome-ignore lint/suspicious/noExplicitAny: the bridge uses connect/subscribeEvents/close/hello/rawRequest.
	} as any;

	const deps: AudioMeterBridgeDeps = {
		connect: async () => {
			const ok =
				connectOutcomes[Math.min(idx, connectOutcomes.length - 1)] ?? false;
			idx += 1;
			if (!ok) throw new Error("engine down (test)");
			return client;
		},
		connectOptions: {},
		broadcast: (payload) => broadcasts.push(payload),
		meterPreference: () => preference,
		logger: silent,
		random: () => 0.5,
		setTimer: (fn: () => void, _ms: number): TimerHandle => {
			timers.push({ fn });
			return timers.length as unknown as TimerHandle;
		},
		clearTimer: () => {},
		baseDelayMs: 1,
		maxDelayMs: 4,
	};

	return {
		deps,
		broadcasts,
		emit: (event: EventParams) => handler?.(event),
		fireNextTimer: async () => {
			const next = timers.shift();
			next?.fn();
			await settleAudioMeterBridge();
		},
		pendingTimers: () => timers.length,
		reloads,
		setPreference: (next: string | null) => {
			preference = next;
		},
		failReloads: () => {
			reloadRejects = true;
		},
		state: () => ({ subscriptionClosed, clientClosed, subscribedTopics }),
	};
}

const levelEvent: Extract<EventParams, { type: "audio-level" }> = {
	type: "audio-level",
	seq: 3,
	source: { identity: "card:usbaudio", owner: "sidecar" },
	channels: 2,
	rms_db: [-18, -19],
	peak_db: [-6, -7],
	floor_db: -1e6,
};

const unavailableEvent: Extract<EventParams, { type: "audio-level" }> = {
	type: "audio-level",
	seq: 4,
	unavailable: true,
	reason: "mode_none",
};

afterEach(() => stopAudioMeterBridge());

describe("audio-meter bridge — forwards engine audio-level over the main WS", () => {
	test("subscribes to ONLY the audio-level topic and forwards a level event", async () => {
		const h = harness([true]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		expect(h.state().subscribedTopics).toEqual(["audio-level"]);

		h.emit(levelEvent);
		expect(h.broadcasts).toHaveLength(1);
		expect(h.broadcasts[0]).toEqual({
			source: { identity: "card:usbaudio", owner: "sidecar" },
			channels: 2,
			rms_db: [-18, -19],
			peak_db: [-6, -7],
			floor_db: -1e6,
		});
		// The envelope `type`/`seq` are dropped — the broadcast layer stamps seq.
		expect("type" in (h.broadcasts[0] as object)).toBe(false);
		expect("seq" in (h.broadcasts[0] as object)).toBe(false);
	});

	test("forwards the `unavailable` marker verbatim (never a fabricated level)", async () => {
		const h = harness([true]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		h.emit(unavailableEvent);
		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "mode_none" }]);
	});

	test("ignores non-audio-level events on the shared subscription", async () => {
		const h = harness([true]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		h.emit({
			type: "bitrate",
			seq: 1,
			current_bitrate: 4000,
			max_bitrate: 6000,
		});
		expect(h.broadcasts).toHaveLength(0);
	});

	test("retries the initial connect with backoff when the engine is down at boot", async () => {
		const h = harness([false, false, true]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		// First attempt failed → a retry is armed, nothing subscribed yet.
		expect(h.state().subscribedTopics).toBeUndefined();
		expect(h.pendingTimers()).toBe(1);

		await h.fireNextTimer(); // 2nd attempt fails → re-arm
		expect(h.state().subscribedTopics).toBeUndefined();
		expect(h.pendingTimers()).toBe(1);

		await h.fireNextTimer(); // 3rd attempt succeeds → subscribed, no more timers
		expect(h.state().subscribedTopics).toEqual(["audio-level"]);
		expect(h.pendingTimers()).toBe(0);

		h.emit(levelEvent);
		expect(h.broadcasts).toHaveLength(1);
	});

	test("stop() closes the subscription and connection and halts forwarding", async () => {
		const h = harness([true]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		stopAudioMeterBridge();
		expect(h.state().subscriptionClosed).toBe(true);
		expect(h.state().clientClosed).toBe(true);

		h.emit(levelEvent);
		expect(h.broadcasts).toHaveLength(0);
	});
});

describe("toAudioLevelMessage — envelope projection", () => {
	test("keeps every level field and drops type/seq", () => {
		expect(toAudioLevelMessage(levelEvent)).toEqual({
			source: { identity: "card:usbaudio", owner: "sidecar" },
			channels: 2,
			rms_db: [-18, -19],
			peak_db: [-6, -7],
			floor_db: -1e6,
		});
	});
});

// The board bug (live QA, 2026-07-25): the operator selected the RØDE, the picker
// showed the RØDE, and the idle meter still reported the DJI — because nothing ever
// told the engine what the operator had chosen. This bridge already holds the ONE
// long-lived idle connection to the engine, so it is where the pick is delivered.
describe("audio-meter bridge — the operator's audio pick reaches the idle meter", () => {
	test("pushes the selected card over reload-config as soon as it connects", async () => {
		const h = harness([true]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		expect(h.reloads).toEqual([
			{ audio: { meter_device: "hw:CARD=usbaudio" } },
		]);
	});

	test('"Auto" sends an explicit null — hand selection back to the engine', async () => {
		const h = harness([true]);
		h.setPreference(null);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		expect(h.reloads).toEqual([{ audio: { meter_device: null } }]);
	});

	test("re-pushes after the operator changes the audio source", async () => {
		const h = harness([true]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		h.setPreference("hw:CARD=MINI");
		syncAudioMeterPreference();
		await settleAudioMeterBridge();
		await Promise.resolve();

		expect(h.reloads).toEqual([
			{ audio: { meter_device: "hw:CARD=usbaudio" } },
			{ audio: { meter_device: "hw:CARD=MINI" } },
		]);
	});

	test("sends NOTHING to an engine older than schema 0.9.0", async () => {
		const h = harness([true], "0.8.0");
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		expect(h.reloads).toEqual([]);
		// The meter itself is untouched — an old engine still auto-picks and streams.
		h.emit(levelEvent);
		expect(h.broadcasts).toHaveLength(1);
	});

	test("a refused reload never breaks the meter", async () => {
		const h = harness([true]);
		h.failReloads();
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		h.emit(levelEvent);
		expect(h.broadcasts).toHaveLength(1);
	});

	test("syncing while the bridge is down is a silent no-op", () => {
		stopAudioMeterBridge();
		expect(() => syncAudioMeterPreference()).not.toThrow();
	});
});

// The board bug (live QA, 2026-07-25): with NOTHING plugged into the RK3588
// HDMI-RX port, selecting "HDMI Input" as the audio source showed moving bars on
// both channels. Verified on a Rock 5B+: the `rockchiphdmiin` card exposes no
// capture PCM substream without a signal (`alsasrc device=hw:CARD=rockchiphdmiin`
// → "No such file or directory") and never enters the engine's device list, so
// the meter_device preference was inert and the meter stayed on a USB mic. Those
// bars were real audio — from the wrong device.
describe("audio-meter bridge — a level from an unselected card is never rendered", () => {
	test("reports the selected device as unavailable instead of another card's audio", async () => {
		const h = harness([true]);
		h.setPreference("hw:CARD=rockchiphdmiin");
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		h.emit(levelEvent);

		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "no_device" }]);
	});

	test("forwards the level untouched once the selected card IS the metered one", async () => {
		const h = harness([true]);
		h.setPreference("hw:CARD=usbaudio");
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		h.emit(levelEvent);

		expect(h.broadcasts).toEqual([toAudioLevelMessage(levelEvent)]);
	});

	test("never suppresses a level it cannot prove foreign (Auto, or no identity)", async () => {
		const h = harness([true]);
		h.setPreference(null);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.emit(levelEvent);

		h.setPreference("hw:CARD=rockchiphdmiin");
		h.emit({ ...levelEvent, source: { owner: "sidecar" } });

		expect(h.broadcasts).toHaveLength(2);
		expect(h.broadcasts.every((b) => b.unavailable === undefined)).toBe(true);
	});

	test("passes an engine-sent unavailable marker through with its own reason", async () => {
		const h = harness([true]);
		h.setPreference("hw:CARD=rockchiphdmiin");
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		h.emit(unavailableEvent);

		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "mode_none" }]);
	});
});

describe("alsaCardKey / isForeignCardLevel — card identity, not literal spelling", () => {
	test("every ALSA spelling of one card reduces to the same key", () => {
		for (const spelling of [
			"usbaudio",
			"hw:CARD=usbaudio",
			"plughw:CARD=usbaudio,DEV=0",
			"card:usbaudio",
		]) {
			expect(alsaCardKey(spelling)).toBe("usbaudio");
		}
		expect(alsaCardKey(undefined)).toBeUndefined();
		expect(alsaCardKey("   ")).toBeUndefined();
	});

	test("a mismatch is only claimed when BOTH sides name a card", () => {
		expect(isForeignCardLevel("hw:CARD=rockchiphdmiin", "card:Rx")).toBe(true);
		expect(isForeignCardLevel("hw:CARD=usbaudio", "card:usbaudio")).toBe(false);
		expect(isForeignCardLevel(null, "card:Rx")).toBe(false);
		expect(isForeignCardLevel("hw:CARD=rockchiphdmiin", undefined)).toBe(false);
	});
});

describe("supportsMeterDevicePreference — fail-safe schema gate", () => {
	test("0.9.0 and later support it; earlier and unparseable do not", () => {
		for (const v of ["0.9.0", "0.10.0", "1.0.0"]) {
			expect(supportsMeterDevicePreference(v)).toBe(true);
		}
		for (const v of ["0.8.0", "0.4.0", "", undefined, "nonsense"]) {
			expect(supportsMeterDevicePreference(v)).toBe(false);
		}
	});
});
