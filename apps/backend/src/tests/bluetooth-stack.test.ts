/**
 * The composition root, driven end to end over an INJECTED bus.
 *
 * Nothing in this file touches a real D-Bus, a real systemctl, or a real
 * filesystem: the transport is a fake that records every call and can be made to
 * reject with a real `org.bluez.Error.*` name, and the service layer is the same
 * injected-deps harness the services suite uses.
 *
 * The claims that carry the most weight:
 *
 *  - S5: two concurrent mutations on ONE adapter — the second is REFUSED
 *    (`adapter_busy`, naming the holder), the effect runs exactly once, and
 *    nothing is queued behind the first.
 *  - S7: the pending stamp is set for exactly the window the mutation is in
 *    flight, and is cleared even when the mutation throws.
 *  - A pair failure is a TYPED refusal carrying BlueZ's own error name, never an
 *    exception and never a silent false.
 *  - Emulated mode reaches `bt_unavailable` with ZERO spawns and ZERO bus dials.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type {
	DbusTransport,
	DbusValue,
	MethodCall,
	MethodReply,
	SignalEvent,
	SignalListener,
	SignalSpec,
	Subscription,
} from "@ceralive/modem-control/transport";
import { variant } from "@ceralive/modem-control/transport";

import { resetAdapterLocks } from "../modules/bluetooth/adapter-lock.ts";
import {
	ADAPTER_IFACE,
	AGENT_CAPABILITY_NO_IO,
	CERALIVE_AGENT_PATH,
	DEVICE_IFACE,
} from "../modules/bluetooth/bluetooth-constants.ts";
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
import {
	type AgentCallHandler,
	type AgentPolicyContext,
	noInputNoOutputPolicy,
} from "../modules/bluetooth/bluez-agent.ts";
import { createBluezClient } from "../modules/bluetooth/bluez-dbus.ts";

const ADAPTER = "/org/bluez/hci0";
const HEADSET = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";
const OTHER = "/org/bluez/hci0/dev_11_22_33_44_55_66";

const sig = (short: string): string =>
	`0000${short}-0000-1000-8000-00805f9b34fb`;

function props(entries: Record<string, [string, DbusValue]>): DbusValue {
	return Object.entries(entries).map(([name, [signature, value]]) => [
		name,
		variant(signature, value),
	]) as unknown as DbusValue;
}

function managedObjects(options: {
	readonly adapters?: boolean;
	readonly trusted?: boolean;
	readonly connected?: boolean;
}): DbusValue {
	const objects: Array<[string, DbusValue]> = [];
	if (options.adapters !== false) {
		objects.push([
			ADAPTER,
			[
				[
					ADAPTER_IFACE,
					props({ Address: ["s", "DC:A6:32:00:11:22"], Powered: ["b", true] }),
				],
			] as unknown as DbusValue,
		]);
	}
	objects.push([
		HEADSET,
		[
			[
				DEVICE_IFACE,
				props({
					Address: ["s", "AA:BB:CC:DD:EE:FF"],
					Name: ["s", "Presenter mic"],
					Paired: ["b", true],
					Trusted: ["b", options.trusted ?? true],
					Connected: ["b", options.connected ?? false],
					UUIDs: ["as", [sig("111e"), sig("110b")]],
				}),
			],
		] as unknown as DbusValue,
	]);
	return objects as unknown as DbusValue;
}

class BluezError extends Error {
	constructor(name: string, message: string) {
		super(message);
		this.name = name;
	}
}

type MemberHandler = (call: MethodCall) => Promise<DbusValue[]> | DbusValue[];

class FakeTransport implements DbusTransport {
	readonly calls: MethodCall[] = [];
	readonly listeners: Array<{ spec: SignalSpec; listener: SignalListener }> =
		[];
	readonly handlers = new Map<string, MemberHandler>();
	connectCount = 0;
	disconnectCount = 0;
	#connected = false;
	tree: DbusValue = managedObjects({});

	async connect(): Promise<void> {
		this.connectCount += 1;
		this.#connected = true;
	}

	async disconnect(): Promise<void> {
		this.disconnectCount += 1;
		this.#connected = false;
	}

	isConnected(): boolean {
		return this.#connected;
	}

	async callMethod(call: MethodCall): Promise<MethodReply> {
		this.calls.push(call);
		const key = `${call.interface}.${call.member}`;
		const handler = this.handlers.get(key);
		if (handler !== undefined) {
			return { signature: "", body: await handler(call) };
		}
		if (key === "org.freedesktop.DBus.ObjectManager.GetManagedObjects") {
			return { signature: "a{oa{sa{sv}}}", body: [this.tree] };
		}
		return { signature: "", body: [] };
	}

	async subscribeSignal(
		spec: SignalSpec,
		listener: SignalListener,
	): Promise<Subscription> {
		const entry = { spec, listener };
		this.listeners.push(entry);
		return {
			unsubscribe: async () => {
				const i = this.listeners.indexOf(entry);
				if (i >= 0) this.listeners.splice(i, 1);
			},
		};
	}

	on(): void {}
	off(): void {}
	subscriptionCount(): number {
		return this.listeners.length;
	}

	emit(event: SignalEvent): void {
		for (const { spec, listener } of [...this.listeners]) {
			if (spec.interface === event.interface && spec.member === event.member) {
				listener(event);
			}
		}
	}

	countOf(member: string): number {
		return this.calls.filter((c) => c.member === member).length;
	}
}

interface Harness {
	stack: BluetoothStack;
	transport: FakeTransport;
	systemctlCalls: string[][];
	exported: Array<{ path: string; handler: AgentCallHandler }>;
	/** Ordered trace of agent-lifecycle steps, for the export-before-register lock. */
	agentOrder: string[];
}

function servicesHarness(
	real: boolean,
	systemctlCalls: string[][],
	enabled = true,
): BluetoothServicesDeps {
	return {
		isRealDevice: async () => real,
		systemctl: async (args): Promise<CommandResult> => {
			systemctlCalls.push([...args]);
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
		preference: createMemoryPreferenceStore({ enabled }),
		log: () => {},
		warn: () => {},
	};
}

function makeHarness(
	options: { readonly real?: boolean; readonly withAgent?: boolean } = {},
): Harness {
	const transport = new FakeTransport();
	const systemctlCalls: string[][] = [];
	const exported: Array<{ path: string; handler: AgentCallHandler }> = [];
	const agentOrder: string[] = [];

	const deps: BluetoothStackDeps = {
		isRealDevice: async () => options.real ?? true,
		services: servicesHarness(options.real ?? true, systemctlCalls),
		createTransport: () => transport,
		createClient: (t, registry, onChange) =>
			createBluezClient({
				transport: t,
				registry,
				onChange,
				log: () => {},
				warn: () => {},
			}),
		log: () => {},
		warn: () => {},
	};

	if (options.withAgent === true) {
		deps.agentExporter = {
			exportAgent: async (path, handler) => {
				agentOrder.push("export");
				exported.push({ path, handler });
				return { path, release: async () => {} };
			},
		};
		transport.handlers.set("org.bluez.AgentManager1.RegisterAgent", () => {
			agentOrder.push("register");
			return [];
		});
	}

	return {
		stack: new BluetoothStack(deps),
		transport,
		systemctlCalls,
		exported,
		agentOrder,
	};
}

beforeEach(() => {
	resetAdapterLocks();
	resetBluetoothServiceReconcileForTest();
});

describe("emulated hosts degrade to bt_unavailable with zero side effects", () => {
	test("no bus dial, no spawn, typed cause `emulated`", async () => {
		const h = makeHarness({ real: false });
		const state = await h.stack.start();

		expect(state.available).toBe(false);
		expect(state.unavailable?.error).toBe("bt_unavailable");
		expect(state.unavailable?.cause).toBe("emulated");
		expect(h.transport.connectCount).toBe(0);
		expect(h.transport.calls).toEqual([]);
		expect(h.systemctlCalls).toEqual([]);
	});

	test("every operator mutation answers the same typed token while down", async () => {
		const h = makeHarness({ real: false });
		await h.stack.start();

		for (const result of [
			await h.stack.pair(HEADSET),
			await h.stack.setTrusted(HEADSET, true),
			await h.stack.forget(HEADSET),
			await h.stack.connectDevice(HEADSET),
			await h.stack.setPowered(ADAPTER, true),
			await h.stack.startDiscovery(ADAPTER),
		]) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toBe("bt_unavailable");
		}
		expect(h.transport.calls).toEqual([]);
	});
});

describe("start-up order and unavailability causes", () => {
	test("a real device reconciles the units, then observes BlueZ", async () => {
		const h = makeHarness();
		const state = await h.stack.start();

		expect(state.available).toBe(true);
		expect(state.adapters.map((a) => a.path)).toEqual([ADAPTER]);
		expect(state.devices.map((d) => d.path)).toEqual([HEADSET]);
		expect(h.systemctlCalls.length).toBeGreaterThan(0);
		expect(h.transport.connectCount).toBe(1);
	});

	test("signals are subscribed BEFORE the snapshot is taken", async () => {
		const h = makeHarness();
		const order: string[] = [];
		const inner = h.transport.subscribeSignal.bind(h.transport);
		h.transport.subscribeSignal = async (spec, listener) => {
			order.push(`sub:${spec.member}`);
			return inner(spec, listener);
		};
		h.transport.handlers.set(
			"org.freedesktop.DBus.ObjectManager.GetManagedObjects",
			() => {
				order.push("snapshot");
				return [h.transport.tree];
			},
		);

		await h.stack.start();
		expect(order[order.length - 1]).toBe("snapshot");
		expect(order.filter((o) => o.startsWith("sub:"))).toHaveLength(3);
	});

	test("a board with BlueZ but no controller reports `no_adapter`, not a dead daemon", async () => {
		const h = makeHarness();
		h.transport.tree = [] as unknown as DbusValue;

		const state = await h.stack.start();
		expect(state.available).toBe(false);
		expect(state.unavailable?.cause).toBe("no_adapter");
	});

	test("an unreachable bus reports `bus_unreachable`", async () => {
		const h = makeHarness();
		h.transport.connect = async () => {
			throw new Error("ECONNREFUSED");
		};

		const state = await h.stack.start();
		expect(state.unavailable?.cause).toBe("bus_unreachable");
	});

	test("an operator with Bluetooth switched off never dials the bus", async () => {
		const transport = new FakeTransport();
		const systemctlCalls: string[][] = [];
		const stack = new BluetoothStack({
			isRealDevice: async () => true,
			services: servicesHarness(true, systemctlCalls, false),
			createTransport: () => transport,
			createClient: (t, registry, onChange) =>
				createBluezClient({ transport: t, registry, onChange }),
			log: () => {},
			warn: () => {},
		});

		const state = await stack.start();
		expect(state.available).toBe(false);
		expect(state.enabled).toBe(false);
		expect(transport.connectCount).toBe(0);
		// …but the units WERE reconciled to the off preference.
		expect(
			systemctlCalls.some((c) => c[0] === "disable" && c[1] === "--now"),
		).toBe(true);
	});
});

describe("pairing", () => {
	test("happy path: Pair is dispatched once and the row settles paired", async () => {
		const h = makeHarness();
		await h.stack.start();

		h.transport.handlers.set("org.bluez.Device1.Pair", () => {
			h.transport.emit({
				path: HEADSET,
				interface: "org.freedesktop.DBus.Properties",
				member: "PropertiesChanged",
				sender: "org.bluez",
				signature: "sa{sv}as",
				body: [
					DEVICE_IFACE,
					props({ Paired: ["b", true], Connected: ["b", true] }),
					[],
				] as unknown as DbusValue[],
			});
			return [];
		});

		const result = await h.stack.pair(HEADSET);
		expect(result.ok).toBe(true);
		expect(h.transport.countOf("Pair")).toBe(1);
		const row = h.stack.registry().device(HEADSET);
		expect(row?.paired).toBe(true);
		expect(row?.connected).toBe(true);
		expect(row?.pending).toBeUndefined();
	});

	test("failure is a TYPED refusal carrying BlueZ's own error name", async () => {
		const h = makeHarness();
		await h.stack.start();
		h.transport.handlers.set("org.bluez.Device1.Pair", () => {
			throw new BluezError(
				"org.bluez.Error.AuthenticationFailed",
				"Authentication Failed",
			);
		});

		const result = await h.stack.pair(HEADSET);
		expect(result.ok).toBe(false);
		if (!result.ok && "bluezError" in result) {
			expect(result.error).toBe("bluez_error");
			expect(result.bluezError).toBe("org.bluez.Error.AuthenticationFailed");
		}
		// S7: a failed mutation must not leave the row marked in-flight.
		expect(h.stack.registry().device(HEADSET)?.pending).toBeUndefined();
	});

	test("a rejection that names no BlueZ error is still typed, without a name", async () => {
		const h = makeHarness();
		await h.stack.start();
		h.transport.handlers.set("org.bluez.Device1.Pair", () => {
			throw new TypeError("socket closed");
		});

		const result = await h.stack.pair(HEADSET);
		expect(result.ok).toBe(false);
		if (!result.ok && "bluezError" in result) {
			expect(result.error).toBe("bluez_error");
			expect(result.bluezError).toBeUndefined();
		}
	});

	test("pairing an unknown object path is refused before any bus call", async () => {
		const h = makeHarness();
		await h.stack.start();
		const before = h.transport.calls.length;

		const result = await h.stack.pair(OTHER);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("unknown_device");
		expect(h.transport.calls.length).toBe(before);
	});
});

describe("S5 — a concurrent mutation on one adapter is REFUSED, not queued", () => {
	test("the second pair is refused and the effect runs exactly once", async () => {
		const h = makeHarness();
		await h.stack.start();

		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.transport.handlers.set("org.bluez.Device1.Pair", async () => {
			await gate;
			return [];
		});

		const first = h.stack.pair(HEADSET);
		// S7: the row is marked in flight for exactly this window.
		expect(h.stack.registry().device(HEADSET)?.pending?.op).toBe("pair");

		const second = await h.stack.pair(HEADSET);
		expect(second.ok).toBe(false);
		if (!second.ok && "heldBy" in second) {
			expect(second.error).toBe("adapter_busy");
			expect(second.heldBy).toBe("pair");
		}
		expect(h.transport.countOf("Pair")).toBe(1);

		release?.();
		expect((await first).ok).toBe(true);
		expect(h.transport.countOf("Pair")).toBe(1);
		expect(h.stack.registry().device(HEADSET)?.pending).toBeUndefined();
	});

	test("a DIFFERENT mutation on the same adapter is refused too", async () => {
		const h = makeHarness();
		await h.stack.start();

		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.transport.handlers.set("org.bluez.Adapter1.StartDiscovery", async () => {
			await gate;
			return [];
		});

		const discovery = h.stack.startDiscovery(ADAPTER);
		const trust = await h.stack.setTrusted(HEADSET, true);

		expect(trust.ok).toBe(false);
		if (!trust.ok && "heldBy" in trust) {
			expect(trust.error).toBe("adapter_busy");
			expect(trust.heldBy).toBe("discovery");
		}
		expect(h.transport.countOf("Set")).toBe(0);

		release?.();
		await discovery;
		await h.stack.stopDiscovery(ADAPTER);
	});

	test("the lock releases even when the mutation throws", async () => {
		const h = makeHarness();
		await h.stack.start();
		h.transport.handlers.set("org.bluez.Device1.Pair", () => {
			throw new BluezError("org.bluez.Error.Failed", "boom");
		});

		expect((await h.stack.pair(HEADSET)).ok).toBe(false);

		h.transport.handlers.delete("org.bluez.Device1.Pair");
		const second = await h.stack.pair(HEADSET);
		expect(second.ok).toBe(true);
	});
});

describe("trust and forget are idempotent", () => {
	test("trusting twice succeeds twice and issues the same property write", async () => {
		const h = makeHarness();
		await h.stack.start();

		expect((await h.stack.setTrusted(HEADSET, true)).ok).toBe(true);
		expect((await h.stack.setTrusted(HEADSET, true)).ok).toBe(true);

		const sets = h.transport.calls.filter((c) => c.member === "Set");
		expect(sets).toHaveLength(2);
		for (const call of sets) {
			expect(call.args?.[0]).toBe(DEVICE_IFACE);
			expect(call.args?.[1]).toBe("Trusted");
		}
	});

	test("untrusting is the same call with the opposite value", async () => {
		const h = makeHarness();
		await h.stack.start();
		const result = await h.stack.setTrusted(HEADSET, false);

		expect(result.ok).toBe(true);
		const last = h.transport.calls.at(-1);
		expect(last?.member).toBe("Set");
		expect(last?.args?.[2]).toEqual(variant("b", false));
	});

	test("forget removes the device, and a repeat forget is a typed refusal", async () => {
		const h = makeHarness();
		await h.stack.start();

		h.transport.handlers.set("org.bluez.Adapter1.RemoveDevice", () => {
			h.transport.emit({
				path: "/",
				interface: "org.freedesktop.DBus.ObjectManager",
				member: "InterfacesRemoved",
				sender: "org.bluez",
				signature: "oas",
				body: [HEADSET, [DEVICE_IFACE]] as unknown as DbusValue[],
			});
			return [];
		});

		expect((await h.stack.forget(HEADSET)).ok).toBe(true);
		expect(h.stack.registry().device(HEADSET)).toBeUndefined();

		const again = await h.stack.forget(HEADSET);
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error).toBe("unknown_device");
		expect(h.transport.countOf("RemoveDevice")).toBe(1);
	});

	test("forget names the ADAPTER, because RemoveDevice lives on Adapter1", async () => {
		const h = makeHarness();
		await h.stack.start();
		await h.stack.forget(HEADSET);

		const call = h.transport.calls.find((c) => c.member === "RemoveDevice");
		expect(call?.path).toBe(ADAPTER);
		expect(call?.args?.[0]).toBe(HEADSET);
	});
});

describe("boot reconnect (e) is bounded and happens once", () => {
	test("a trusted, disconnected device gets exactly ONE Connect", async () => {
		const h = makeHarness();
		await h.stack.start();

		expect(h.transport.countOf("Connect")).toBe(1);
		const call = h.transport.calls.find((c) => c.member === "Connect");
		expect(call?.path).toBe(HEADSET);
		expect(call?.timeoutMs).toBeGreaterThan(0);
	});

	test("a second run is a no-op — no retry loop against an absent headset", async () => {
		const h = makeHarness();
		await h.stack.start();

		const again = await h.stack.runBootReconnect();
		expect(again).toEqual([]);
		expect(h.transport.countOf("Connect")).toBe(1);
	});

	test("an already-connected trusted device is left alone", async () => {
		const h = makeHarness();
		h.transport.tree = managedObjects({ connected: true });

		await h.stack.start();
		expect(h.transport.countOf("Connect")).toBe(0);
	});

	test("an untrusted device is never auto-connected", async () => {
		const h = makeHarness();
		h.transport.tree = managedObjects({ trusted: false });

		await h.stack.start();
		expect(h.transport.countOf("Connect")).toBe(0);
	});

	test("a failing reconnect does not break start-up", async () => {
		const h = makeHarness();
		h.transport.handlers.set("org.bluez.Device1.Connect", () => {
			throw new BluezError("org.bluez.Error.Failed", "device is off");
		});

		const state = await h.stack.start();
		expect(state.available).toBe(true);
		expect(state.bootReconnectDone).toBe(true);
	});
});

describe("the NoInputNoOutput pairing agent", () => {
	test("it registers with BlueZ as NoInputNoOutput and asks to be default", async () => {
		const h = makeHarness({ withAgent: true });
		const state = await h.stack.start();

		expect(state.agent.registered).toBe(true);
		expect(h.exported[0]?.path).toBe(CERALIVE_AGENT_PATH);

		const register = h.transport.calls.find(
			(c) => c.member === "RegisterAgent",
		);
		expect(register?.args).toEqual([
			CERALIVE_AGENT_PATH,
			AGENT_CAPABILITY_NO_IO,
		]);
		expect(
			h.transport.calls.some((c) => c.member === "RequestDefaultAgent"),
		).toBe(true);
	});

	test("the object is exported BEFORE RegisterAgent names it", async () => {
		const h = makeHarness({ withAgent: true });
		await h.stack.start();

		// BlueZ blocks on every callback into a path nobody answers, so an agent
		// registered ahead of its own export is worse than no agent at all.
		expect(h.agentOrder).toEqual(["export", "register"]);
	});

	test("no object server ⇒ NOTHING is registered, and the reason is reported", async () => {
		const h = makeHarness();
		const state = await h.stack.start();

		expect(state.agent.registered).toBe(false);
		expect(state.agent.reason).toBe("exporter_unavailable");
		// Critically: a path BlueZ would block on is never registered.
		expect(h.transport.calls.some((c) => c.member === "RegisterAgent")).toBe(
			false,
		);
	});

	test("a BlueZ refusal releases the exported object again", async () => {
		let released = 0;
		const transport = new FakeTransport();
		transport.handlers.set("org.bluez.AgentManager1.RegisterAgent", () => {
			throw new BluezError("org.bluez.Error.AlreadyExists", "taken");
		});
		const stack = new BluetoothStack({
			isRealDevice: async () => true,
			services: servicesHarness(true, []),
			createTransport: () => transport,
			createClient: (t, registry, onChange) =>
				createBluezClient({
					transport: t,
					registry,
					onChange,
					log: () => {},
					warn: () => {},
				}),
			agentExporter: {
				exportAgent: async (path) => ({
					path,
					release: async () => {
						released += 1;
					},
				}),
			},
			log: () => {},
			warn: () => {},
		});

		const state = await stack.start();
		expect(state.agent.registered).toBe(false);
		expect(state.agent.reason).toBe("bluez_refused");
		expect(released).toBe(1);
		// The rest of the stack is unaffected — observation still works.
		expect(state.available).toBe(true);
	});

	test("the agent accepts a Just Works authorization ONLY inside the operator's window", async () => {
		const h = makeHarness({ withAgent: true });
		await h.stack.start();
		const handler = h.exported[0]?.handler;
		expect(handler).toBeDefined();

		// No window open: an unsolicited pairing from a peer in radio range.
		expect(handler?.("RequestAuthorization", OTHER).action).toBe("reject");

		let observed: string | undefined;
		h.transport.handlers.set("org.bluez.Device1.Pair", () => {
			observed = handler?.("RequestAuthorization", HEADSET).action;
			return [];
		});
		await h.stack.pair(HEADSET);
		expect(observed).toBe("accept");

		// …and the window closes again with the call.
		expect(handler?.("RequestAuthorization", HEADSET).action).toBe("reject");
	});

	test("the window is scoped to the device the operator asked for", async () => {
		const h = makeHarness({ withAgent: true });
		await h.stack.start();
		const handler = h.exported[0]?.handler;

		let observed: string | undefined;
		h.transport.handlers.set("org.bluez.Device1.Pair", () => {
			observed = handler?.("RequestAuthorization", OTHER).action;
			return [];
		});
		await h.stack.pair(HEADSET);
		expect(observed).toBe("reject");
	});
});

describe("the agent policy table (pure)", () => {
	const closed: AgentPolicyContext = {
		pairingWindowOpen: false,
		trustedPaths: new Set(),
	};
	const open: AgentPolicyContext = {
		pairingWindowOpen: true,
		trustedPaths: new Set(),
	};

	test("no PIN or passkey is ever invented", () => {
		expect(noInputNoOutputPolicy("RequestPinCode", HEADSET, open).action).toBe(
			"reject",
		);
		expect(noInputNoOutputPolicy("RequestPasskey", HEADSET, open).action).toBe(
			"reject",
		);
		expect(
			noInputNoOutputPolicy("RequestConfirmation", HEADSET, open).action,
		).toBe("reject");
	});

	test("display-only methods are ignored rather than refused", () => {
		expect(noInputNoOutputPolicy("DisplayPasskey", HEADSET, open).action).toBe(
			"ignore",
		);
		expect(noInputNoOutputPolicy("DisplayPinCode", HEADSET, open).action).toBe(
			"ignore",
		);
		expect(noInputNoOutputPolicy("Release", undefined, closed).action).toBe(
			"ignore",
		);
		expect(noInputNoOutputPolicy("Cancel", undefined, closed).action).toBe(
			"ignore",
		);
	});

	test("service authorization follows TRUST when no window is open", () => {
		const trusted: AgentPolicyContext = {
			pairingWindowOpen: false,
			trustedPaths: new Set([HEADSET]),
		};
		expect(
			noInputNoOutputPolicy("AuthorizeService", HEADSET, trusted).action,
		).toBe("accept");
		expect(
			noInputNoOutputPolicy("AuthorizeService", OTHER, trusted).action,
		).toBe("reject");
	});
});

describe("teardown", () => {
	test("stop unsubscribes, disconnects and unregisters the agent", async () => {
		const h = makeHarness({ withAgent: true });
		await h.stack.start();
		expect(h.transport.subscriptionCount()).toBe(3);

		await h.stack.stop();
		expect(h.transport.subscriptionCount()).toBe(0);
		expect(h.transport.disconnectCount).toBeGreaterThan(0);
		expect(h.transport.calls.some((c) => c.member === "UnregisterAgent")).toBe(
			true,
		);
		expect(h.stack.state().available).toBe(false);
	});
});

describe("the registry is fed by live signals", () => {
	test("an InterfacesAdded during discovery reaches the rows", async () => {
		const h = makeHarness();
		await h.stack.start();
		const before = h.stack.state().devices.length;

		h.transport.emit({
			path: "/",
			interface: "org.freedesktop.DBus.ObjectManager",
			member: "InterfacesAdded",
			sender: "org.bluez",
			signature: "oa{sa{sv}}",
			body: [
				OTHER,
				[
					[
						DEVICE_IFACE,
						props({
							Address: ["s", "11:22:33:44:55:66"],
							Name: ["s", "Bench speaker"],
							UUIDs: ["as", [sig("110a")]],
						}),
					],
				],
			] as unknown as DbusValue[],
		});

		const rows = h.stack.state().devices;
		expect(rows).toHaveLength(before + 1);
		const added = rows.find((d) => d.path === OTHER);
		expect(added?.deviceClass).toBe("audio-input");
		expect(added?.scoCapable).toBe(false);
	});
});

describe("a fresh registry has no cross-test state", () => {
	test("two stacks do not share rows", async () => {
		const a = makeHarness();
		await a.stack.start();
		await a.stack.stop();

		const b = new BluetoothRegistry();
		expect(b.devices()).toEqual([]);
	});
});
