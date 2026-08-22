/**
 * MID-STREAM Bluetooth-microphone loss, and the boot return.
 *
 * The load-bearing claims, in the order the file asserts them:
 *
 *  1. `dropped` and `gone` are DIFFERENT registry facts and take different
 *     operator bands — the terminal one replaces the retractable one in place.
 *  2. The verdict is HYSTERETIC. A drop shorter than the grace window says
 *     NOTHING, because that window is exactly what cerastream's own actuator
 *     spends failing over to silence and rebuilding the ALSA source.
 *  3. A reconnect costs EXACTLY TWO things: one meter-preference re-assert and
 *     the notification transitions. NOTHING else reaches the engine — there is
 *     no re-promote RPC, and this file proves the absence against a real
 *     injected engine client rather than asserting it in prose.
 *  4. A reconnect STORM is BOUNDED: five events in two seconds cost one
 *     re-assert, zero notifications, and zero extra engine calls.
 *  5. Boot: the trusted-device reconnect is attempted once per process and a
 *     module re-init (a reboot) re-arms it, and the runtime's publish order is
 *     registry → picker → presence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	CerastreamClient,
	EventHandler,
	Subscription as EventSubscription,
} from "@ceralive/cerastream";
import type {
	DbusTransport,
	DbusValue,
	MethodCall,
	MethodReply,
	SignalListener,
	SignalSpec,
	Subscription,
} from "@ceralive/modem-control/transport";
import { variant } from "@ceralive/modem-control/transport";

import { resetAdapterLocks } from "../modules/bluetooth/adapter-lock.ts";
import { DEVICE_IFACE } from "../modules/bluetooth/bluetooth-constants.ts";
import { createMemoryPreferenceStore } from "../modules/bluetooth/bluetooth-preference.ts";
import { BluetoothRegistry } from "../modules/bluetooth/bluetooth-registry.ts";
import type {
	BluetoothServicesDeps,
	CommandResult,
} from "../modules/bluetooth/bluetooth-services.ts";
import { resetBluetoothServiceReconcileForTest } from "../modules/bluetooth/bluetooth-services.ts";
import {
	BluetoothStack,
	type BluetoothStackDeps,
} from "../modules/bluetooth/bluetooth-stack.ts";
import type { BluezClient } from "../modules/bluetooth/bluez-dbus.ts";
import {
	type AudioMeterBridgeDeps,
	initAudioMeterBridge,
	settleAudioMeterBridge,
	stopAudioMeterBridge,
	syncAudioMeterPreference,
} from "../modules/streaming/audio-meter-bridge.ts";
import type { BluetoothAudioDevice } from "../modules/streaming/bluetooth-audio.ts";
import {
	addressOfBluetoothSourceId,
	BLUETOOTH_REASSERT_INTERVAL_MS,
	BLUETOOTH_SOURCE_DROPPED_NOTIFICATION,
	BLUETOOTH_SOURCE_LOSS_GRACE_MS,
	BLUETOOTH_SOURCE_LOST_NOTIFICATION,
	BLUETOOTH_SOURCE_RECOVERED_NOTIFICATION,
	type BluetoothAudioResilienceDeps,
	classifyBluetoothSourcePresence,
	noteBluetoothAudioPresence,
	resetBluetoothAudioResilience,
	setBluetoothAudioResilienceDepsForTest,
	standingBluetoothAudioBand,
} from "../modules/streaming/bluetooth-audio-resilience.ts";

const ADDRESS = "AA:BB:CC:DD:EE:FF";
const SOURCE_ID = "bt:AA_BB_CC_DD_EE_FF";
const MIC_NAME = "CeraLive Mic";

const connected: BluetoothAudioDevice = {
	address: ADDRESS,
	alias: MIC_NAME,
	name: MIC_NAME,
	connected: true,
	scoCapable: true,
};
const droppedRow: BluetoothAudioDevice = { ...connected, connected: false };
/** The registry retired the `Device1` row entirely — an empty projection. */
const goneRoster: readonly BluetoothAudioDevice[] = [];

interface RaisedNotification {
	name: string;
	type: string;
	msg: string;
	duration: number;
	isPersistent: boolean;
	isDismissable: boolean;
	key: string | undefined;
	params: Record<string, unknown> | undefined;
}

type TimerHandle = ReturnType<typeof setTimeout>;

function harness(options: { streaming?: boolean } = {}) {
	const timers = new Map<number, () => void>();
	let nextTimerId = 1;
	let clock = 10_000;
	let asrc: string | undefined = SOURCE_ID;
	let streaming = options.streaming ?? true;
	const raised: RaisedNotification[] = [];
	const removed: string[] = [];
	let reasserts = 0;
	let reassert = (): void => {
		reasserts += 1;
	};

	const deps: BluetoothAudioResilienceDeps = {
		selectedAsrc: () => asrc,
		isStreaming: () => streaming,
		reassertMeterPreference: () => reassert(),
		notify: (
			name,
			type,
			msg,
			duration = 0,
			isPersistent = false,
			isDismissable = true,
			_authedOnly = true,
			key,
			params,
		) => {
			raised.push({
				name,
				type,
				msg,
				duration,
				isPersistent,
				isDismissable,
				key,
				params,
			});
		},
		removeNotification: (name) => {
			removed.push(name);
			return { remove: [{ id: name, revision: 1 }] };
		},
		now: () => clock,
		setTimer: (fn) => {
			const id = nextTimerId++;
			timers.set(id, fn);
			return id as unknown as TimerHandle;
		},
		clearTimer: (timer) => {
			timers.delete(timer as unknown as number);
		},
		log: () => {},
	};

	setBluetoothAudioResilienceDepsForTest(deps);

	return {
		raised,
		removed,
		reasserts: () => reasserts,
		armedTimers: () => timers.size,
		setReassert: (fn: () => void) => {
			reassert = fn;
		},
		setAsrc: (next: string | undefined) => {
			asrc = next;
		},
		setStreaming: (next: boolean) => {
			streaming = next;
		},
		advance: (ms: number) => {
			clock += ms;
		},
		/** Fire every armed timer once, as the event loop would after the grace. */
		fireTimers: () => {
			const pending = [...timers.entries()];
			timers.clear();
			for (const [, fn] of pending) fn();
		},
	};
}

afterEach(() => {
	setBluetoothAudioResilienceDepsForTest(null);
	resetBluetoothAudioResilience();
});

// ─── 1. the registry verdict ────────────────────────────────────────────────

describe("dropped and gone are different registry facts", () => {
	test("present / dropped / gone, matched case-insensitively on the address", () => {
		expect(classifyBluetoothSourcePresence(ADDRESS, [connected])).toBe(
			"present",
		);
		expect(classifyBluetoothSourcePresence(ADDRESS, [droppedRow])).toBe(
			"dropped",
		);
		expect(classifyBluetoothSourcePresence(ADDRESS, goneRoster)).toBe("gone");
		expect(
			classifyBluetoothSourcePresence(ADDRESS.toLowerCase(), [
				{ ...connected, address: ADDRESS.toLowerCase() },
			]),
		).toBe("present");
	});

	test("a foreign device's row answers nothing about ours", () => {
		expect(
			classifyBluetoothSourcePresence(ADDRESS, [
				{ ...connected, address: "11:22:33:44:55:66" },
			]),
		).toBe("gone");
	});

	test("only a bt: pick carries an address", () => {
		expect(addressOfBluetoothSourceId(SOURCE_ID)).toBe(ADDRESS);
		expect(addressOfBluetoothSourceId("hw:CARD=usbaudio")).toBeUndefined();
		expect(addressOfBluetoothSourceId(undefined)).toBeUndefined();
		expect(addressOfBluetoothSourceId("bt:")).toBeUndefined();
	});
});

// ─── 2. the hysteresis ──────────────────────────────────────────────────────

describe("a drop is only reported once it outlives the engine's own failover", () => {
	test("a drop shorter than the grace window says NOTHING", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS - 1);
		noteBluetoothAudioPresence([droppedRow]);

		expect(h.raised).toEqual([]);
		expect(h.removed).toEqual([]);
		expect(standingBluetoothAudioBand()).toBe("none");
	});

	test("a drop that outlives it raises ONE persistent band naming the device", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();

		expect(h.raised).toHaveLength(1);
		const band = h.raised[0];
		expect(band?.name).toBe(BLUETOOTH_SOURCE_DROPPED_NOTIFICATION);
		expect(band?.type).toBe("warning");
		expect(band?.isPersistent).toBe(true);
		expect(band?.isDismissable).toBe(true);
		expect(band?.key).toBe("notifications.bluetoothSourceDropped");
		expect(band?.params).toEqual({ name: MIC_NAME });
		// The CeraUI-side statement of the engine's silence companion — the whole
		// reason this band is not an error: the stream is still on the air.
		expect(band?.msg).toContain(MIC_NAME);
		expect(band?.msg).toContain("silence");
		expect(standingBluetoothAudioBand()).toBe("dropped");
	});

	test("a still-dropped re-observation never re-toasts", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();
		h.advance(60_000);
		noteBluetoothAudioPresence([droppedRow]);
		noteBluetoothAudioPresence([droppedRow]);

		expect(h.raised).toHaveLength(1);
	});

	test("the window is measured from the FIRST degraded observation, never extended by a later one", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		// Three more degraded edges inside the window must not renew it.
		for (let i = 0; i < 3; i += 1) {
			h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS / 4);
			noteBluetoothAudioPresence([droppedRow]);
		}
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS / 2);
		noteBluetoothAudioPresence([droppedRow]);

		expect(h.raised).toHaveLength(1);
		expect(h.raised[0]?.name).toBe(BLUETOOTH_SOURCE_DROPPED_NOTIFICATION);
	});
});

// ─── 3. gone is terminal ────────────────────────────────────────────────────

describe("a device the registry retired gets the TERMINAL band", () => {
	test("gone raises the lost band as an error", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence(goneRoster);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();

		expect(h.raised).toHaveLength(1);
		expect(h.raised[0]?.name).toBe(BLUETOOTH_SOURCE_LOST_NOTIFICATION);
		expect(h.raised[0]?.type).toBe("error");
		expect(h.raised[0]?.isPersistent).toBe(true);
		expect(h.raised[0]?.key).toBe("notifications.bluetoothSourceLost");
		expect(h.raised[0]?.params).toEqual({ name: MIC_NAME });
		expect(standingBluetoothAudioBand()).toBe("gone");
	});

	test("an escalation REPLACES the drop band rather than stacking on it", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();
		noteBluetoothAudioPresence(goneRoster);

		expect(h.removed).toEqual([BLUETOOTH_SOURCE_DROPPED_NOTIFICATION]);
		expect(h.raised.map((n) => n.name)).toEqual([
			BLUETOOTH_SOURCE_DROPPED_NOTIFICATION,
			BLUETOOTH_SOURCE_LOST_NOTIFICATION,
		]);
		expect(standingBluetoothAudioBand()).toBe("gone");
	});

	test("a terminal band is never silently downgraded back to a drop", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence(goneRoster);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();
		noteBluetoothAudioPresence([droppedRow]);

		expect(h.raised).toHaveLength(1);
		expect(standingBluetoothAudioBand()).toBe("gone");
	});

	test("DROPPED is stream-gated; GONE is a standing fact either way", () => {
		const h = harness({ streaming: false });
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();
		expect(h.raised).toEqual([]);

		noteBluetoothAudioPresence(goneRoster);
		expect(h.raised.map((n) => n.name)).toEqual([
			BLUETOOTH_SOURCE_LOST_NOTIFICATION,
		]);
	});
});

// ─── 4. absence is not evidence ─────────────────────────────────────────────

describe("a device we never saw working is never reported lost", () => {
	test("a trusted mic that is simply switched off at boot stays silent", () => {
		const h = harness();
		// Boot: the row exists (paired + trusted) but has never connected.
		noteBluetoothAudioPresence([droppedRow]);
		h.advance(60_000);
		noteBluetoothAudioPresence([droppedRow]);
		noteBluetoothAudioPresence(goneRoster);

		expect(h.raised).toEqual([]);
		expect(h.removed).toEqual([]);
		expect(h.armedTimers()).toBe(0);
	});

	test("a non-Bluetooth pick retracts whatever we said about the previous mic", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence(goneRoster);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();
		expect(standingBluetoothAudioBand()).toBe("gone");

		h.setAsrc("hw:CARD=usbaudio");
		noteBluetoothAudioPresence(goneRoster);

		expect(h.removed).toEqual([BLUETOOTH_SOURCE_LOST_NOTIFICATION]);
		expect(standingBluetoothAudioBand()).toBe("none");
	});
});

// ─── 5. the reconnect duties ────────────────────────────────────────────────

describe("a reconnect costs exactly two things", () => {
	test("the band is cleared, a recovery toast fires, and the meter preference is re-asserted ONCE", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();
		h.advance(100);
		noteBluetoothAudioPresence([connected]);

		expect(h.removed).toEqual([BLUETOOTH_SOURCE_DROPPED_NOTIFICATION]);
		expect(h.raised.map((n) => n.name)).toEqual([
			BLUETOOTH_SOURCE_DROPPED_NOTIFICATION,
			BLUETOOTH_SOURCE_RECOVERED_NOTIFICATION,
		]);
		const recovered = h.raised[1];
		expect(recovered?.type).toBe("success");
		expect(recovered?.isPersistent).toBe(false);
		expect(recovered?.key).toBe("notifications.bluetoothSourceRecovered");
		expect(recovered?.params).toEqual({ name: MIC_NAME });
		expect(h.reasserts()).toBe(1);
		expect(standingBluetoothAudioBand()).toBe("none");
	});

	test("a device that never left costs no re-assert at all", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		h.advance(60_000);
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([connected]);

		expect(h.reasserts()).toBe(0);
		expect(h.raised).toEqual([]);
	});

	test("a re-assert that throws never breaks the reconcile", () => {
		const h = harness();
		h.setReassert(() => {
			throw new Error("bridge is down (test)");
		});
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();
		noteBluetoothAudioPresence([connected]);

		expect(standingBluetoothAudioBand()).toBe("none");
	});
});

// ─── 6. the QA-failure fixture: a reconnect STORM ───────────────────────────

describe("a reconnect storm is BOUNDED", () => {
	test("five events in two seconds cost one re-assert and zero notification transitions", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);

		// Five drop/return pairs, 400 ms apart — 2 s of a flapping radio, every
		// gap comfortably inside the grace window.
		for (let i = 0; i < 5; i += 1) {
			noteBluetoothAudioPresence([droppedRow]);
			h.advance(200);
			noteBluetoothAudioPresence([connected]);
			h.advance(200);
		}

		expect(h.raised).toEqual([]);
		expect(h.removed).toEqual([]);
		expect(h.reasserts()).toBe(1);
		expect(standingBluetoothAudioBand()).toBe("none");
	});

	test("the floor releases once the interval has genuinely elapsed", () => {
		const h = harness();
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		noteBluetoothAudioPresence([connected]);
		expect(h.reasserts()).toBe(1);

		h.advance(BLUETOOTH_REASSERT_INTERVAL_MS);
		noteBluetoothAudioPresence([droppedRow]);
		noteBluetoothAudioPresence([connected]);
		expect(h.reasserts()).toBe(2);
	});
});

// ─── 7. the engine surface: meter reload-config, and nothing else ───────────

/**
 * A REAL `audio-meter-bridge` over an injected engine client, so "no engine call
 * beyond the meter reload-config" is a measurement rather than a claim. The
 * client records every `rawRequest` it is handed; a re-promote RPC (there is
 * none, and none may be added) would show up here as a foreign method.
 */
function engineHarness() {
	const calls: Array<{ method: string; params: unknown }> = [];
	let handler: EventHandler | undefined;
	let closed = false;
	let subscribeCount = 0;

	const subscription: EventSubscription = {
		result: { topics: ["audio-level"] },
		close: () => {},
	};
	const client = {
		subscribeEvents: async (
			params: { topics: readonly string[] },
			h: EventHandler,
		) => {
			subscribeCount += 1;
			handler = h;
			return { ...subscription, result: { topics: params.topics } };
		},
		close: async () => {
			closed = true;
		},
		hello: { schema_version: "0.9.0" },
		rawRequest: async (method: string, params?: unknown) => {
			calls.push({ method, params });
			return {};
		},
		// biome-ignore lint/suspicious/noExplicitAny: only the five members above are used.
	} as any as CerastreamClient;

	const deps: AudioMeterBridgeDeps = {
		connect: async () => client,
		connectOptions: {},
		broadcast: () => {},
		meterPreference: () => "bluealsa:DEV=AA:BB:CC:DD:EE:FF,PROFILE=sco",
		meterPreferencePresent: () => true,
		meterSilenced: () => false,
		launchInFlight: () => false,
		logger: { info: () => {}, warn: () => {}, debug: () => {} },
		random: () => 0.5,
		now: () => 0,
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (timer) => clearTimeout(timer),
		baseDelayMs: 1,
		maxDelayMs: 4,
	};

	return {
		deps,
		calls,
		closed: () => closed,
		subscribeCount: () => subscribeCount,
		emitted: () => handler !== undefined,
	};
}

const drain = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the engine surface a reconnect touches", () => {
	afterEach(() => {
		stopAudioMeterBridge();
	});

	test("a reconnect issues the meter reload-config and NOTHING else", async () => {
		const engine = engineHarness();
		initAudioMeterBridge(engine.deps);
		await settleAudioMeterBridge();
		await drain();
		// The connect itself pushes the preference once — that is the baseline.
		expect(engine.calls).toHaveLength(1);

		const h = harness();
		h.setReassert(syncAudioMeterPreference);
		noteBluetoothAudioPresence([connected]);
		noteBluetoothAudioPresence([droppedRow]);
		h.advance(BLUETOOTH_SOURCE_LOSS_GRACE_MS);
		h.fireTimers();
		noteBluetoothAudioPresence([connected]);
		await drain();

		expect(engine.calls).toHaveLength(2);
		for (const call of engine.calls) {
			expect(call.method).toBe("reload-config");
			expect(call.params).toEqual({
				audio: { meter_device: "bluealsa:DEV=AA:BB:CC:DD:EE:FF,PROFILE=sco" },
			});
		}
		// No session was torn down, no second subscription, no re-promote.
		expect(engine.subscribeCount()).toBe(1);
		expect(engine.closed()).toBe(false);
	});

	test("a STORM adds at most one reload-config to that baseline", async () => {
		const engine = engineHarness();
		initAudioMeterBridge(engine.deps);
		await settleAudioMeterBridge();
		await drain();

		const h = harness();
		h.setReassert(syncAudioMeterPreference);
		noteBluetoothAudioPresence([connected]);
		for (let i = 0; i < 5; i += 1) {
			noteBluetoothAudioPresence([droppedRow]);
			h.advance(200);
			noteBluetoothAudioPresence([connected]);
			h.advance(200);
		}
		await drain();

		expect(engine.calls).toHaveLength(2);
		expect(engine.calls.every((c) => c.method === "reload-config")).toBe(true);
	});
});

// ─── 8. boot: the trusted-device reconnect, and the publish ORDER ───────────

const HEADSET_PATH = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";

function props(entries: Record<string, [string, DbusValue]>): DbusValue {
	return Object.entries(entries).map(([name, [signature, value]]) => [
		name,
		variant(signature, value),
	]) as unknown as DbusValue;
}

function ifaces(entries: Record<string, DbusValue>): DbusValue {
	return Object.entries(entries) as unknown as DbusValue;
}

class InertTransport implements DbusTransport {
	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}
	async callMethod(_call: MethodCall): Promise<MethodReply> {
		return { signature: "", body: [] };
	}
	async subscribeSignal(
		_spec: SignalSpec,
		_listener: SignalListener,
	): Promise<Subscription> {
		return { unsubscribe: async () => {} };
	}
	on(): void {}
	off(): void {}
}

function servicesHarness(): BluetoothServicesDeps {
	return {
		isRealDevice: async () => true,
		systemctl: async (args): Promise<CommandResult> => {
			if (args[0] === "is-enabled") {
				return { exitCode: 0, stdout: "enabled\n", stderr: "" };
			}
			if (args[0] === "is-active") {
				return { exitCode: 0, stdout: "active\n", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		probeHelp: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		fileExists: async () => false,
		readFile: async () => undefined,
		writeDropIn: async () => {},
		preference: createMemoryPreferenceStore({ enabled: true }),
		log: () => {},
		warn: () => {},
	};
}

/** A client that seeds ONE trusted, paired, disconnected headset on connect. */
function bootStack(connectAttempts: string[]): BluetoothStack {
	const deps: BluetoothStackDeps = {
		isRealDevice: async () => true,
		services: servicesHarness(),
		createTransport: () => new InertTransport(),
		createClient: (_transport, registry, onChange): BluezClient => ({
			connect: async () => {
				registry.applyInterfacesAdded(
					HEADSET_PATH,
					ifaces({
						[DEVICE_IFACE]: props({
							Address: ["s", ADDRESS],
							Alias: ["s", MIC_NAME],
							Paired: ["b", true],
							Trusted: ["b", true],
							Connected: ["b", false],
						}),
					}),
				);
				onChange?.();
				return { ok: true, value: { adapters: [] } };
			},
			disconnect: async () => {},
			refresh: async () => ({ ok: true, value: undefined }),
			setPowered: async () => ({ ok: true, value: true }),
			startDiscovery: async () => ({ ok: true, value: undefined }),
			stopDiscovery: async () => ({ ok: true, value: undefined }),
			pair: async () => ({ ok: true, value: undefined }),
			setTrusted: async () => ({ ok: true, value: true }),
			forget: async () => ({ ok: true, value: undefined }),
			connectDevice: async (devicePath) => {
				connectAttempts.push(devicePath);
				return { ok: true, value: undefined };
			},
			disconnectDevice: async () => ({ ok: true, value: undefined }),
		}),
		log: () => {},
		warn: () => {},
	};
	return new BluetoothStack(deps);
}

describe("boot: the trusted mic is reconnected once, and a reboot re-arms it", () => {
	beforeEach(() => {
		resetAdapterLocks();
		resetBluetoothServiceReconcileForTest();
	});

	test("ONE attempt per process, and a module re-init attempts again", async () => {
		const attempts: string[] = [];
		const stack = bootStack(attempts);
		await stack.start();
		expect(attempts).toEqual([HEADSET_PATH]);

		// Latched: a second call inside the same process attempts nothing.
		await stack.runBootReconnect();
		expect(attempts).toEqual([HEADSET_PATH]);

		// Reboot simulation: the runtime drops the singleton, so a fresh stack is
		// built and the latch is re-armed exactly once.
		resetBluetoothServiceReconcileForTest();
		const rebooted = bootStack(attempts);
		await rebooted.start();
		expect(attempts).toEqual([HEADSET_PATH, HEADSET_PATH]);
	});

	test("the mic that comes back at boot repopulates the picker BEFORE it is judged", () => {
		const h = harness({ streaming: false });
		// The boot order: the registry projection is published, the picker is
		// re-folded from it, and only then is presence reconciled. A device
		// present in that projection must produce NO loss band.
		const registry = new BluetoothRegistry();
		registry.applyInterfacesAdded(
			HEADSET_PATH,
			ifaces({
				[DEVICE_IFACE]: props({
					Address: ["s", ADDRESS],
					Alias: ["s", MIC_NAME],
					Paired: ["b", true],
					Trusted: ["b", true],
					Connected: ["b", true],
				}),
			}),
		);
		const projection = registry.devices().map((device) => ({
			address: device.address,
			alias: device.name,
			name: device.name,
			connected: device.connected,
			scoCapable: device.scoCapable,
		}));

		noteBluetoothAudioPresence(projection);

		expect(h.raised).toEqual([]);
		expect(standingBluetoothAudioBand()).toBe("none");
	});
});

describe("the runtime publishes registry → picker → presence, in that order", () => {
	test("source-order lock on bluetooth-runtime.ts", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(
			join(here, "..", "modules", "bluetooth", "bluetooth-runtime.ts"),
			"utf8",
		);
		const note = source.indexOf("mod.noteBluetoothRegistryDevices(");
		const refresh = source.indexOf("audio.refreshBluetoothAudioDevices()");
		const presence = source.indexOf("resilience.noteBluetoothAudioPresence(");

		expect(note).toBeGreaterThan(-1);
		expect(refresh).toBeGreaterThan(note);
		expect(presence).toBeGreaterThan(refresh);
	});
});
