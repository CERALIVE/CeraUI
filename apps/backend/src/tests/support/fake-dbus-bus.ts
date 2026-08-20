/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * An in-memory system bus carrying enough of ModemManager's ObjectManager
 * surface to drive the REAL `MmDbusObserver`.
 *
 * It models the ONE property the observer's correctness turns on and a hand-rolled
 * stub usually omits: every emitted signal carries a `sender`, so an old-epoch
 * straggler is genuinely distinguishable from a current-owner event.
 */

import type { DecodedManagedObjects } from "@ceralive/modem-control";
import type {
	DbusTransport,
	MethodCall,
	MethodReply,
	SignalEvent,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from "@ceralive/modem-control/transport";

const MM_BUS_NAME = "org.freedesktop.ModemManager1";
const MM_ROOT_PATH = "/org/freedesktop/ModemManager1";

export interface FakeBusOptions {
	readonly owner?: string;
	readonly tree?: DecodedManagedObjects;
	/** Gate `connect()` on an externally-resolved promise (cancellation tests). */
	readonly connectGate?: Promise<void>;
	/** Gate `GetManagedObjects` on an externally-resolved promise. */
	readonly snapshotGate?: Promise<void>;
}

export class FakeBus {
	#owner: string | undefined;
	#tree: DecodedManagedObjects;
	#listeners = new Map<string, Set<SignalListener>>();
	#connectGate: Promise<void> | undefined;
	#snapshotGate: Promise<void> | undefined;

	connected = false;
	disconnectCount = 0;
	snapshotCalls = 0;
	/** Fails the NEXT `GetManagedObjects` — the `bus-error` failure class. */
	failNextSnapshot = false;

	constructor(options: FakeBusOptions = {}) {
		this.#owner = options.owner ?? ":1.9";
		this.#tree = options.tree ?? [];
		this.#connectGate = options.connectGate;
		this.#snapshotGate = options.snapshotGate;
	}

	get owner(): string | undefined {
		return this.#owner;
	}

	setTree(tree: DecodedManagedObjects): void {
		this.#tree = tree;
	}

	/** Model a ModemManager restart: the name is lost, then re-acquired. */
	restartModemManager(newOwner: string): void {
		const oldOwner = this.#owner ?? "";
		this.#owner = undefined;
		this.#emit(
			"org.freedesktop.DBus",
			"NameOwnerChanged",
			"org.freedesktop.DBus",
			{
				path: "/org/freedesktop/DBus",
				body: [MM_BUS_NAME, oldOwner, ""],
			},
		);
		this.#owner = newOwner;
		this.#emit(
			"org.freedesktop.DBus",
			"NameOwnerChanged",
			"org.freedesktop.DBus",
			{
				path: "/org/freedesktop/DBus",
				body: [MM_BUS_NAME, "", newOwner],
			},
		);
	}

	interfacesAdded(objectPath: string, sender = this.#owner ?? ""): void {
		this.#emit(
			"org.freedesktop.DBus.ObjectManager",
			"InterfacesAdded",
			sender,
			{ path: MM_ROOT_PATH, body: [objectPath, []] },
		);
	}

	interfacesRemoved(objectPath: string, sender = this.#owner ?? ""): void {
		this.#emit(
			"org.freedesktop.DBus.ObjectManager",
			"InterfacesRemoved",
			sender,
			{ path: MM_ROOT_PATH, body: [objectPath, []] },
		);
	}

	propertiesChanged(objectPath: string, sender = this.#owner ?? ""): void {
		this.#emit("org.freedesktop.DBus.Properties", "PropertiesChanged", sender, {
			path: objectPath,
			body: ["org.freedesktop.ModemManager1.Modem", [], []],
		});
	}

	transport(): DbusTransport {
		const bus = this;
		return {
			async connect(): Promise<void> {
				if (bus.#connectGate !== undefined) {
					await bus.#connectGate;
				}
				bus.connected = true;
			},
			async disconnect(): Promise<void> {
				bus.disconnectCount += 1;
				bus.connected = false;
			},
			isConnected: () => bus.connected,
			async callMethod(call: MethodCall): Promise<MethodReply> {
				if (call.member === "GetNameOwner") {
					if (bus.#owner === undefined) {
						throw new Error("org.freedesktop.DBus.Error.NameHasNoOwner");
					}
					return { signature: "s", body: [bus.#owner] };
				}
				if (call.member === "GetManagedObjects") {
					if (bus.#snapshotGate !== undefined) {
						await bus.#snapshotGate;
					}
					bus.snapshotCalls += 1;
					if (bus.failNextSnapshot) {
						bus.failNextSnapshot = false;
						throw new Error("org.freedesktop.DBus.Error.NoReply");
					}
					return {
						signature: "a{oa{sa{sv}}}",
						body: [bus.#tree as never],
					};
				}
				throw new Error(`unexpected call ${call.interface}.${call.member}`);
			},
			async subscribeSignal(
				spec: SignalSpec,
				listener: SignalListener,
			): Promise<Subscription> {
				const key = `${spec.interface}.${spec.member}`;
				const set = bus.#listeners.get(key) ?? new Set<SignalListener>();
				set.add(listener);
				bus.#listeners.set(key, set);
				return {
					async unsubscribe(): Promise<void> {
						set.delete(listener);
					},
				};
			},
			on: (_event: TransportEvent, _handler: (payload?: unknown) => void) =>
				undefined,
			off: (_event: TransportEvent, _handler: (payload?: unknown) => void) =>
				undefined,
			subscriptionCount: () =>
				[...bus.#listeners.values()].reduce((n, set) => n + set.size, 0),
		};
	}

	#emit(
		iface: string,
		member: string,
		sender: string,
		event: { path: string; body: SignalEvent["body"] },
	): void {
		const listeners = this.#listeners.get(`${iface}.${member}`);
		if (listeners === undefined) {
			return;
		}
		for (const listener of [...listeners]) {
			listener({
				path: event.path,
				interface: iface,
				member,
				sender,
				signature: "",
				body: event.body,
			});
		}
	}
}
