import { afterEach, describe, expect, test } from "bun:test";

import type {
	DbusTransport,
	DbusValue,
	MethodCall,
	MethodReply,
	SignalEvent,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from "@ceralive/modem-control/transport";
import {
	DbusSmsPortRegistry,
	setActiveDbusSmsPortRegistry,
} from "../modules/modems/dbus-sms.ts";
import { readSmsInbox } from "../modules/modems/mmcli-sms.ts";

const MODEM_11 = "/org/freedesktop/ModemManager1/Modem/11";
const MODEM_0 = "/org/freedesktop/ModemManager1/Modem/0";
const MODEM_4 = "/org/freedesktop/ModemManager1/Modem/4";
const SMS_1 = "/org/freedesktop/ModemManager1/SMS/1";
const SMS_2 = "/org/freedesktop/ModemManager1/SMS/2";
const ID_PATH = "platform-xhci-hcd.0.auto-usb-0:1.4";

const variant = (signature: string, value: DbusValue): DbusValue => ({
	signature,
	value,
});

function props(path: string): DbusValue {
	const id = path.slice(path.lastIndexOf("/") + 1);
	return Object.entries({
		State: variant("u", 3),
		Number: variant("s", `sender-${id}`),
		Text: variant("s", `neutral body ${id}`),
		Timestamp: variant("s", `2025-08-2${id}T17:20:16-05`),
	}).map(([key, value]) => [key, value]);
}

interface SmsFakeBus {
	readonly transport: DbusTransport;
	readonly calls: MethodCall[];
	readonly activeSubscriptions: ReadonlySet<string>;
	inbox: string[];
	listFailures: number;
	unsubscribeFailures: number;
	emitSignal(
		path: string,
		member: "Added" | "Deleted",
		body: DbusValue[],
	): void;
	emitReconnect(): void;
}

function fakeBus(): SmsFakeBus {
	const calls: MethodCall[] = [];
	const listeners = new Map<string, Set<SignalListener>>();
	const handlers = new Map<TransportEvent, Set<(payload?: unknown) => void>>();
	const active = new Set<string>();
	const bus: SmsFakeBus = {
		calls,
		inbox: [],
		listFailures: 0,
		unsubscribeFailures: 0,
		activeSubscriptions: active,
		transport: {
			connect: async () => {},
			disconnect: async () => {},
			isConnected: () => true,
			async callMethod(call: MethodCall): Promise<MethodReply> {
				calls.push(call);
				if (call.member === "List" && bus.listFailures > 0) {
					bus.listFailures -= 1;
					throw new Error("list unavailable");
				}
				return call.member === "List"
					? { signature: "ao", body: [bus.inbox] }
					: { signature: "a{sv}", body: [props(call.path)] };
			},
			async subscribeSignal(
				spec: SignalSpec,
				listener: SignalListener,
			): Promise<Subscription> {
				const key = `${spec.path ?? "*"}:${spec.member}`;
				const set = listeners.get(key) ?? new Set<SignalListener>();
				set.add(listener);
				listeners.set(key, set);
				active.add(key);
				return {
					async unsubscribe(): Promise<void> {
						set.delete(listener);
						active.delete(key);
						if (bus.unsubscribeFailures > 0) {
							bus.unsubscribeFailures -= 1;
							throw new Error("unsubscribe unavailable");
						}
					},
				};
			},
			on(event: TransportEvent, handler: (payload?: unknown) => void): void {
				const set =
					handlers.get(event) ?? new Set<(payload?: unknown) => void>();
				set.add(handler);
				handlers.set(event, set);
			},
			off(event: TransportEvent, handler: (payload?: unknown) => void): void {
				handlers.get(event)?.delete(handler);
			},
			subscriptionCount: () => active.size,
		},
		emitSignal(path, member, body): void {
			const event: SignalEvent = {
				path,
				interface: "org.freedesktop.ModemManager1.Modem.Messaging",
				member,
				sender: undefined,
				signature: "",
				body,
			};
			for (const listener of listeners.get(`${path}:${member}`) ?? []) {
				listener(event);
			}
		},
		emitReconnect(): void {
			for (const handler of handlers.get("reconnected") ?? []) handler();
		},
	};
	return bus;
}

const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
	setActiveDbusSmsPortRegistry(null);
});

describe("D-Bus SMS port lifecycle", () => {
	test("an epoch renumber stops path 11, rebuilds path 0, and keeps one inbox row", async () => {
		const bus = fakeBus();
		bus.inbox = [SMS_1];
		const registry = new DbusSmsPortRegistry(bus.transport);
		registry.noteEpoch("epoch-a", [{ runtimeId: 11, idPath: ID_PATH }]);
		await registry.settle();

		const initial = await registry.read("11");
		expect(initial).toEqual({
			ok: true,
			messages: [
				{
					id: "1",
					from: "sender-1",
					text: "neutral body 1",
					timestamp: "2025-08-21T17:20:16-05",
					state: "received",
				},
			],
		});
		expect(bus.activeSubscriptions).toEqual(
			new Set([`${MODEM_11}:Added`, `${MODEM_11}:Deleted`]),
		);

		registry.noteEpoch("epoch-b", [{ runtimeId: 0, idPath: ID_PATH }]);
		await registry.settle();

		expect(bus.activeSubscriptions).toEqual(
			new Set([`${MODEM_0}:Added`, `${MODEM_0}:Deleted`]),
		);
		bus.emitSignal(MODEM_11, "Added", [SMS_2, true]);
		bus.emitSignal(MODEM_0, "Added", [SMS_1, true]);
		await settle();
		const renumbered = await registry.read("0");
		expect(
			renumbered.ok && renumbered.messages.map((message) => message.id),
		).toEqual(["1"]);
		expect(
			bus.calls.filter(
				(call) => call.member === "List" && call.path === MODEM_11,
			).length,
		).toBeGreaterThan(0);
		expect(
			bus.calls.filter(
				(call) => call.member === "List" && call.path === MODEM_0,
			).length,
		).toBeGreaterThan(0);

		registry.noteEpoch("epoch-b", [{ runtimeId: 4, idPath: ID_PATH }]);
		await registry.settle();
		expect(bus.activeSubscriptions).toEqual(
			new Set([`${MODEM_4}:Added`, `${MODEM_4}:Deleted`]),
		);
		await registry.stop();
	});

	test("Added and Deleted fold without another list, while reconnect resync replaces", async () => {
		const bus = fakeBus();
		bus.inbox = [SMS_1];
		const registry = new DbusSmsPortRegistry(bus.transport);
		registry.noteEpoch("epoch-a", [{ runtimeId: 11, idPath: ID_PATH }]);
		await registry.settle();
		await registry.read("11");
		const listsAfterStartup = bus.calls.filter(
			(call) => call.member === "List",
		).length;

		bus.inbox = [SMS_1, SMS_2];
		bus.emitSignal(MODEM_11, "Added", [SMS_2, true]);
		await settle();
		expect(bus.calls.filter((call) => call.member === "List")).toHaveLength(
			listsAfterStartup,
		);
		const folded = await registry.read("11");
		expect(folded.ok && folded.messages.map((message) => message.id)).toEqual([
			"2",
			"1",
		]);

		bus.emitSignal(MODEM_11, "Deleted", [SMS_1]);
		await settle();
		const afterDelete = await registry.read("11");
		expect(
			afterDelete.ok && afterDelete.messages.map((message) => message.id),
		).toEqual(["2"]);
		expect(bus.calls.filter((call) => call.member === "List")).toHaveLength(
			listsAfterStartup,
		);

		bus.inbox = [SMS_2];
		bus.emitReconnect();
		await settle();
		const resynced = await registry.read("11");
		expect(
			resynced.ok && resynced.messages.map((message) => message.id),
		).toEqual(["2"]);
		await registry.stop();
	});

	test("a failed initial list is typed, retryable, and does not poison later epochs", async () => {
		const bus = fakeBus();
		bus.inbox = [SMS_1];
		bus.listFailures = 2;
		const registry = new DbusSmsPortRegistry(bus.transport);
		registry.noteEpoch("epoch-a", [{ runtimeId: 11, idPath: ID_PATH }]);
		await registry.settle();

		expect(await registry.read("11")).toEqual({
			ok: false,
			reason: "read_failed",
		});
		expect(await registry.read("11")).toMatchObject({ ok: true });

		bus.unsubscribeFailures = 1;
		registry.noteEpoch("epoch-b", [{ runtimeId: 0, idPath: ID_PATH }]);
		await registry.settle();
		expect(await registry.read("0")).toMatchObject({ ok: true });
		await registry.stop();
	});

	test("the D-Bus and mmcli readers return the same normalized inbox", async () => {
		const bus = fakeBus();
		bus.inbox = [SMS_1, SMS_2];
		const registry = new DbusSmsPortRegistry(bus.transport);
		registry.noteEpoch("epoch-a", [{ runtimeId: 11, idPath: ID_PATH }]);
		await registry.settle();

		const viaDbus = await registry.read("11");
		const viaMmcli = await readSmsInbox("11", async (args) => {
			if (args.includes("--messaging-list-sms")) {
				return [
					"modem.messaging.sms.length: 2",
					`modem.messaging.sms.value[1]: ${SMS_1}`,
					`modem.messaging.sms.value[2]: ${SMS_2}`,
				].join("\n");
			}
			const path = args[args.indexOf("-s") + 1] ?? SMS_1;
			const id = path.slice(path.lastIndexOf("/") + 1);
			return [
				`sms.dbus-path: ${path}`,
				`sms.content.number: sender-${id}`,
				`sms.content.text: neutral body ${id}`,
				"sms.properties.state: received",
				`sms.properties.timestamp: 2025-08-2${id}T17:20:16-05`,
			].join("\n");
		});

		expect(viaDbus).toEqual(viaMmcli);
		await registry.stop();
	});
});
