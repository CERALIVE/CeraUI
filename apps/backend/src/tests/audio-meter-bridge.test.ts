import { afterEach, describe, expect, test } from "bun:test";
import type {
	CerastreamClient,
	EventHandler,
	EventParams,
	Subscription,
} from "@ceralive/cerastream";
import { type AudioLevelMessage, LIFECYCLE_STATES } from "@ceraui/rpc/schemas";
import {
	AUDIO_METER_FRAME_ABSENCE_MS,
	AUDIO_METER_MISMATCH_GRACE_MS,
	AUDIO_METER_REASSERT_INTERVAL_MS,
	type AudioMeterBridgeDeps,
	type AudioMeterBridgeLogger,
	alsaCardKey,
	initAudioMeterBridge,
	isForeignCardLevel,
	launchIsAcquiringAudio,
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

// The re-assert is fired-and-forgotten from a synchronous broadcast path, so its
// two awaited reloads settle over several microtask turns.
const drainMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

// A fake engine: `connect` either throws (engine down) or resolves a client whose
// `subscribeEvents` captures the handler so the test can push events by hand. The
// manual timer queue drives the boot-retry loop with no real time.
function harness(connectOutcomes: boolean[], schemaVersion = "0.9.0") {
	// A real `clearTimeout` un-schedules; the queue therefore has to drop a cleared
	// entry too. The frame-absence watchdog RE-ARMS on every level (it is a debounce
	// on arrival), so a queue that kept cleared handles would let `fireNextTimer`
	// run a superseded watchdog and report an absence that never happened.
	const timers = new Map<number, () => void>();
	let nextTimerId = 1;
	let idx = 0;
	let handler: EventHandler | undefined;
	let subscriptionClosed = false;
	let clientClosed = false;
	let subscribedTopics: readonly string[] | undefined;
	const broadcasts: AudioLevelMessage[] = [];

	const reloads: unknown[] = [];
	let preference: string | null = "hw:CARD=usbaudio";
	let preferencePresent = false;
	let silenced = false;
	let launching = false;
	let clock = 1_000;
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
		meterPreferencePresent: () => preferencePresent,
		meterSilenced: () => silenced,
		launchInFlight: () => launching,
		logger: silent,
		random: () => 0.5,
		now: () => clock,
		setTimer: (fn: () => void, _ms: number): TimerHandle => {
			const id = nextTimerId++;
			timers.set(id, fn);
			return id as unknown as TimerHandle;
		},
		clearTimer: (timer) => {
			timers.delete(timer as unknown as number);
		},
		baseDelayMs: 1,
		maxDelayMs: 4,
	};

	return {
		deps,
		broadcasts,
		emit: (event: EventParams) => handler?.(event),
		fireNextTimer: async () => {
			const id = timers.keys().next().value;
			if (id !== undefined) {
				const fn = timers.get(id);
				timers.delete(id);
				fn?.();
			}
			await settleAudioMeterBridge();
		},
		pendingTimers: () => timers.size,
		reloads,
		setPreference: (next: string | null) => {
			preference = next;
		},
		setPreferencePresent: (next: boolean) => {
			preferencePresent = next;
		},
		setSilenced: (next: boolean) => {
			silenced = next;
		},
		setLaunching: (next: boolean) => {
			launching = next;
		},
		advance: async (ms: number) => {
			clock += ms;
			await drainMicrotasks();
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

// The follow-up board bug (live QA, 2026-07-25): explicitly picking a CONNECTED,
// audio-delivering device left the idle meter on "Meter unavailable · No audio
// device" indefinitely, while "Auto" — resolving to that same device — showed
// bars at once. The gate was right to refuse the other card's audio; what was
// wrong is that it said the device was gone, and that nothing ever re-tried.
describe("audio-meter bridge — a suppressed foreign level names the real cause", () => {
	test("reports the selection as not-metered while CeraUI still lists it", async () => {
		const h = harness([true]);
		h.setPreference("hw:CARD=usbaudio");
		h.setPreferencePresent(true);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		h.emit({
			...levelEvent,
			source: { identity: "card:Rx", owner: "sidecar" },
		});

		expect(h.broadcasts).toEqual([
			{ unavailable: true, reason: "not_selected_device" },
		]);
	});

	test("keeps `no_device` for a selection CeraUI can no longer see", async () => {
		const h = harness([true]);
		h.setPreference("hw:CARD=usbaudio");
		h.setPreferencePresent(false);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		h.emit({
			...levelEvent,
			source: { identity: "card:Rx", owner: "sidecar" },
		});

		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "no_device" }]);
	});
});

describe("audio-meter bridge — a stuck preference is re-asserted, bounded", () => {
	const foreign = {
		...levelEvent,
		source: { identity: "card:Rx", owner: "sidecar" as const },
	};

	async function connectedWithForeignLevels() {
		const h = harness([true]);
		h.setPreference("hw:CARD=usbaudio");
		h.setPreferencePresent(true);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.reloads.length = 0;
		return h;
	}

	test("re-asserts through null only after the grace window, exactly once", async () => {
		const h = await connectedWithForeignLevels();

		h.emit(foreign);
		await h.advance(AUDIO_METER_MISMATCH_GRACE_MS - 1);
		h.emit(foreign);
		expect(h.reloads).toEqual([]);

		await h.advance(2);
		h.emit(foreign);
		await h.advance(0);

		expect(h.reloads).toEqual([
			{ audio: { meter_device: null } },
			{ audio: { meter_device: "hw:CARD=usbaudio" } },
		]);
	});

	test("holds the interval floor rather than re-asserting on every level", async () => {
		const h = await connectedWithForeignLevels();

		h.emit(foreign);
		await h.advance(AUDIO_METER_MISMATCH_GRACE_MS);
		h.emit(foreign);
		await h.advance(0);
		expect(h.reloads).toHaveLength(2);

		await h.advance(AUDIO_METER_REASSERT_INTERVAL_MS - 1);
		h.emit(foreign);
		await h.advance(0);
		expect(h.reloads).toHaveLength(2);

		await h.advance(2);
		h.emit(foreign);
		await h.advance(0);
		expect(h.reloads).toHaveLength(4);
	});

	test("a level from the selected card ends the run and re-arms the grace", async () => {
		const h = await connectedWithForeignLevels();

		h.emit(foreign);
		await h.advance(AUDIO_METER_MISMATCH_GRACE_MS);
		h.emit(levelEvent);
		await h.advance(AUDIO_METER_MISMATCH_GRACE_MS);
		h.emit(foreign);
		await h.advance(0);

		expect(h.reloads).toEqual([]);
	});

	test("never re-asserts for Auto — the engine owns that selection", async () => {
		const h = harness([true]);
		h.setPreference(null);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.reloads.length = 0;

		h.emit(foreign);
		await h.advance(AUDIO_METER_MISMATCH_GRACE_MS * 4);
		h.emit(foreign);
		await h.advance(0);

		expect(h.reloads).toEqual([]);
		expect(h.broadcasts.every((b) => b.unavailable === undefined)).toBe(true);
	});

	test("a refused re-assert leaves levels flowing, never a thrown bridge", async () => {
		const h = await connectedWithForeignLevels();
		h.failReloads();

		h.emit(foreign);
		await h.advance(AUDIO_METER_MISMATCH_GRACE_MS);
		h.emit(foreign);
		await h.advance(0);

		h.setPreference("hw:CARD=Rx");
		h.emit(foreign);
		expect(h.broadcasts.at(-1)).toEqual(toAudioLevelMessage(foreign));
	});
});

// The board bug (live QA, 2026-07-29): the idle meter sat on a bare
// `Meter unavailable` for 14 minutes with no operator action. The engine's level
// feed had simply STOPPED (last `audio-level` 23:34:27Z, board clock 23:48:25Z)
// 2 ms after a changed pick published its `handoff` gap, so the gap was the last
// thing the frontend was ever told. The re-assert above could not rescue it: it is
// driven ENTIRELY by arriving frames, so with zero frames there are no foreign
// readings to accumulate, the grace window never elapses, and every other sync
// trigger is edge-triggered on things that had gone still. Same
// raise-but-never-retract family as `policy_route_missing` and `active_encode` on
// stop — the difference is that the un-retracted state lives in the ENGINE's meter
// sidecar and CeraUI's retraction was gated on the very signal whose absence IS
// the failure.
describe("audio-meter bridge — a feed that STOPS is re-asserted, not left dead", () => {
	async function connectedAndMetering() {
		const h = harness([true]);
		h.setPreference("hw:CARD=usbaudio");
		h.setPreferencePresent(true);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		// One real frame: the baseline that makes a later silence an ABSENCE rather
		// than a connection that has never delivered anything.
		h.emit(levelEvent);
		h.reloads.length = 0;
		return h;
	}

	test("re-asserts through null when the level feed simply stops", async () => {
		const h = await connectedAndMetering();

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);

		expect(h.reloads).toEqual([
			{ audio: { meter_device: null } },
			{ audio: { meter_device: "hw:CARD=usbaudio" } },
		]);
	});

	test("holds the interval floor rather than re-asserting every absence window", async () => {
		const h = await connectedAndMetering();

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);
		expect(h.reloads).toHaveLength(2);

		// A still-silent feed keeps the watchdog armed, but the floor blocks it — so
		// a permanently-dead card costs one cheap reload pair per interval, never a loop.
		await h.advance(AUDIO_METER_REASSERT_INTERVAL_MS - 1);
		await h.fireNextTimer();
		await h.advance(0);
		expect(h.reloads).toHaveLength(2);

		await h.advance(2);
		await h.fireNextTimer();
		await h.advance(0);
		expect(h.reloads).toHaveLength(4);
	});

	test("shares the floor with the foreign-card re-assert — one escape hatch, not two", async () => {
		const h = await connectedAndMetering();
		const foreign = {
			...levelEvent,
			source: { identity: "card:Rx", owner: "sidecar" as const },
		};

		h.emit(foreign);
		await h.advance(AUDIO_METER_MISMATCH_GRACE_MS);
		h.emit(foreign);
		await h.advance(0);
		expect(h.reloads).toHaveLength(2);

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);
		expect(h.reloads).toHaveLength(2);
	});

	test("keeps exactly ONE watchdog armed however many frames arrive", async () => {
		const h = await connectedAndMetering();

		for (let i = 0; i < 5; i++) h.emit(levelEvent);

		expect(h.pendingTimers()).toBe(1);
	});

	test("never fires before the first frame of a fresh connect", async () => {
		const h = harness([true]);
		h.setPreference("hw:CARD=usbaudio");
		h.setPreferencePresent(true);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.reloads.length = 0;

		expect(h.pendingTimers()).toBe(0);
		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS * 4);
		await h.fireNextTimer();
		await h.advance(0);

		expect(h.reloads).toEqual([]);
	});

	// A non-null preference isolates the silence gate: with a `null` one the Auto
	// gate below would refuse the re-assert anyway and prove nothing.
	test("never re-asserts for a silenced pick — the operator asked for silence", async () => {
		const h = harness([true]);
		h.setPreference("hw:CARD=usbaudio");
		h.setPreferencePresent(true);
		h.setSilenced(true);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.emit(levelEvent);
		h.reloads.length = 0;

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);

		expect(h.reloads).toEqual([]);
	});

	test("never re-asserts for Auto — the engine owns that selection", async () => {
		const h = harness([true]);
		h.setPreference(null);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.emit(levelEvent);
		h.reloads.length = 0;

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);

		expect(h.reloads).toEqual([]);
	});

	test("stop() disarms the watchdog", async () => {
		const h = await connectedAndMetering();

		stopAudioMeterBridge();

		expect(h.pendingTimers()).toBe(0);
	});

	test("a refused re-assert leaves levels flowing, never a thrown bridge", async () => {
		const h = await connectedAndMetering();
		h.failReloads();

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);

		h.emit(levelEvent);
		expect(h.broadcasts.at(-1)).toEqual(toAudioLevelMessage(levelEvent));
	});
});

// The board race (live QA, 2026-07-30, Rock 5B+ / DJI Osmo Pocket 3). A stream
// start releases the idle meter ON PURPOSE, so levels legitimately stop — and the
// frame-absence watchdog read that as a stuck feed and re-opened the very card the
// launch was mid-way through acquiring:
//
//   20:03:22.466  streaming.start issued
//   20:03:25.024  audio-meter bridge: no audio level for 2500 ms … re-asserting
//   20:03:25.026  audio-meter bridge: re-asserted the preference hw:CARD=DJIPocket3
//   20:03:27.142  audio-device-unavailable … 'hw:CARD=DJIPocket3' is busy … not_retriable
//
// cerastream's own bounded 1.5 s self-release retry (b6f40ea) cannot win that —
// it is not racing a lagging release, it is racing a PEER that is actively
// re-acquiring. 2/6 starts still failed with the retry in place. The ordering has
// to be fixed here: absence of levels is not evidence of a stuck feed while a
// launch is in flight, because the launch is precisely what silenced them.
describe("audio-meter bridge — a launch owns the card; the watchdog yields to it", () => {
	async function connectedAndMetering() {
		const h = harness([true]);
		h.setPreference("hw:CARD=DJIPocket3");
		h.setPreferencePresent(true);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.emit(levelEvent);
		h.reloads.length = 0;
		return h;
	}

	test("never re-asserts while a launch is acquiring the card", async () => {
		const h = await connectedAndMetering();

		// `streaming.start` issued: the idle meter is released for the handoff, so
		// the level feed goes quiet for a reason that is CORRECT, not broken.
		h.setLaunching(true);

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);

		expect(h.reloads).toEqual([]);
	});

	test("stays ARMED while suppressed — a launch defers the watchdog, never disables it", async () => {
		const h = await connectedAndMetering();
		h.setLaunching(true);

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);

		expect(h.pendingTimers()).toBe(1);
	});

	// The whole point of deferring rather than dropping: a feed that is genuinely
	// dead must still be recovered the moment the launch stops owning the card.
	test("re-asserts on the very next window once the launch resolves", async () => {
		const h = await connectedAndMetering();
		h.setLaunching(true);

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);
		expect(h.reloads).toEqual([]);

		// Launch settled (either way) and no frame has arrived — now it IS a fault.
		h.setLaunching(false);
		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);

		expect(h.reloads).toEqual([
			{ audio: { meter_device: null } },
			{ audio: { meter_device: "hw:CARD=DJIPocket3" } },
		]);
	});

	// A suppressed window must not consume the 30 s floor: that would convert a
	// deferral into a half-minute of real suppression AFTER the launch resolved.
	test("a suppressed window does not spend the re-assert interval floor", async () => {
		const h = await connectedAndMetering();
		h.setLaunching(true);

		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);

		h.setLaunching(false);
		// Deliberately well inside AUDIO_METER_REASSERT_INTERVAL_MS of the
		// suppressed window — if that window had stamped `lastReassertAt`, this
		// would be floored out and the meter would stay dead.
		await h.advance(AUDIO_METER_FRAME_ABSENCE_MS);
		await h.fireNextTimer();
		await h.advance(0);

		expect(h.reloads).toHaveLength(2);
	});

	// The content watchdog shares `reassertPreference`, so it re-opens the same
	// card by the same path and carries the identical risk.
	test("the foreign-card watchdog yields to a launch too", async () => {
		const h = await connectedAndMetering();
		const foreign = {
			...levelEvent,
			source: { identity: "card:Rx", owner: "sidecar" as const },
		};

		h.setLaunching(true);
		h.emit(foreign);
		await h.advance(AUDIO_METER_MISMATCH_GRACE_MS);
		h.emit(foreign);
		await h.advance(0);

		expect(h.reloads).toEqual([]);

		// And it recovers on the next foreign frame once the launch is done.
		h.setLaunching(false);
		h.emit(foreign);
		await h.advance(0);

		expect(h.reloads).toHaveLength(2);
	});
});

// The production binding of the gate. "Resolves" must mean BOTH outcomes: a
// successful launch lands in `streaming`, a failed one in `idle`, and the
// watchdog has to be live again in each. Only the launch window itself defers.
describe("audio-meter bridge — launchIsAcquiringAudio maps the lifecycle", () => {
	test("defers during `starting` and in NO other lifecycle state", () => {
		const deferred = LIFECYCLE_STATES.filter((s) => launchIsAcquiringAudio(s));

		expect(deferred).toEqual(["starting"]);
	});

	test("a resolved launch — success OR failure — re-arms the watchdog", () => {
		expect(launchIsAcquiringAudio("streaming")).toBe(false);
		expect(launchIsAcquiringAudio("idle")).toBe(false);
	});
});

// The Wave H board bug (live QA, 2026-07-26): with "No audio" selected the meter
// drew ACTIVE green bars for several seconds. "No audio" and "Auto" both resolve
// to a `null` meter preference, so the foreign-card gate was never armed for the
// one pick that means "meter nothing" — and `null` on the wire tells the engine
// to auto-pick, so those bars were another card's real, moving audio.
describe("audio-meter bridge — an explicit `No audio` pick meters NOTHING", () => {
	test("reports the silenced pick instead of the card the engine auto-picked", async () => {
		const h = harness([true]);
		h.setPreference(null);
		h.setSilenced(true);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.broadcasts.length = 0;

		h.emit(levelEvent);

		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "mode_none" }]);
	});

	test("outranks the engine's own gap reason — the operator asked for silence", async () => {
		const h = harness([true]);
		h.setPreference(null);
		h.setSilenced(true);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.broadcasts.length = 0;

		h.emit({ ...unavailableEvent, reason: "device_busy" });

		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "mode_none" }]);
	});

	test("leaves `Auto` untouched — the same null preference, the opposite meaning", async () => {
		const h = harness([true]);
		h.setPreference(null);
		h.setSilenced(false);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.broadcasts.length = 0;

		h.emit(levelEvent);

		expect(h.broadcasts).toEqual([toAudioLevelMessage(levelEvent)]);
	});

	test("never re-asserts a preference for a pick that wants no meter at all", async () => {
		const h = harness([true]);
		h.setPreference(null);
		h.setSilenced(true);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.reloads.length = 0;

		h.emit(levelEvent);
		await h.advance(AUDIO_METER_MISMATCH_GRACE_MS * 4);
		h.emit(levelEvent);
		await h.advance(0);

		expect(h.reloads).toEqual([]);
	});
});

// Same live report, second half: the bars were the PREVIOUS device's. Every gate
// above acts on the NEXT engine frame, and the engine needs a moment to re-point
// its sidecar, so the switch window kept rendering a reading that no longer
// belonged to the pick on screen.
describe("audio-meter bridge — a pick change retires the level on screen at once", () => {
	async function connected() {
		const h = harness([true]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.emit(levelEvent);
		h.broadcasts.length = 0;
		return h;
	}

	test("publishes a switching gap before any new engine frame arrives", async () => {
		const h = await connected();

		h.setPreference("hw:CARD=MINI");
		syncAudioMeterPreference();

		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "handoff" }]);
	});

	test("publishes the silenced state when the new pick is `No audio`", async () => {
		const h = await connected();

		h.setPreference(null);
		h.setSilenced(true);
		syncAudioMeterPreference();

		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "mode_none" }]);
	});

	test("sees an Auto → No audio switch that the preference alone cannot", async () => {
		const h = harness([true]);
		h.setPreference(null);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.emit(levelEvent);
		h.broadcasts.length = 0;

		h.setSilenced(true);
		syncAudioMeterPreference();

		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "mode_none" }]);
	});

	test("stays silent when a re-enumeration re-syncs an UNCHANGED pick", async () => {
		const h = await connected();

		syncAudioMeterPreference();
		await settleAudioMeterBridge();

		expect(h.broadcasts).toEqual([]);
	});

	test("never blanks the meter on the first connect — nothing has been shown yet", async () => {
		const h = harness([true]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		expect(h.broadcasts).toEqual([]);
	});

	test("retires the stale reading even while the engine is unreachable", async () => {
		const h = harness([false]);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		syncAudioMeterPreference();
		h.setPreference("hw:CARD=MINI");
		syncAudioMeterPreference();

		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "handoff" }]);
	});

	test("hands the meter straight back to the new device's first real level", async () => {
		const h = await connected();

		h.setPreference("hw:CARD=MINI");
		syncAudioMeterPreference();
		await settleAudioMeterBridge();

		const fromNewCard = {
			...levelEvent,
			source: { identity: "card:MINI", owner: "sidecar" as const },
		};
		h.emit(fromNewCard);

		expect(h.broadcasts.at(-1)).toEqual(toAudioLevelMessage(fromNewCard));
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
