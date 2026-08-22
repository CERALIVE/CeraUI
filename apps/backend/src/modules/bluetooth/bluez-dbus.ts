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
 * The BlueZ D-Bus layer: adapter state, bounded discovery, and the four device
 * mutations (pair / trust / forget / connect).
 *
 * It runs on the SAME `DbusTransport` seam the cellular observation path uses
 * (`@ceralive/modem-control/transport`, contract in
 * `docs/DBUS-OBSERVATION-CONTRACT.md`), so this backend has exactly one D-Bus
 * client abstraction. What it does NOT reuse is
 * `cellular/dbus-audit-transport.ts`: that wrapper is fail-closed READ-ONLY by
 * design, and Bluetooth's whole job here is to mutate. Wrapping the BT path in
 * it would refuse `Device1.Pair` by construction; leaving the CELLULAR path
 * unwrapped would remove the guarantee that makes observing a live
 * ModemManager safe. Two paths, two postures, one transport.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SUBSCRIBE BEFORE SNAPSHOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `connect()` registers the `InterfacesAdded` / `InterfacesRemoved` /
 * `PropertiesChanged` match rules BEFORE it calls `GetManagedObjects`. The other
 * order has a real gap: a device that appears between the snapshot and the
 * subscription is in neither, so it never reaches the registry and never will
 * until something unrelated re-snapshots. Subscribing first can only ever
 * deliver a signal for an object the snapshot then also describes, and the fold
 * is idempotent, so the overlap costs nothing.
 *
 * Signal specs deliberately omit `sender`. The bus daemon resolves a match-rule
 * sender such as `org.bluez`, but delivered messages carry BlueZ's unique sender
 * (`:1.x`); the shared transport also compares that delivered sender literally,
 * which would discard every otherwise-matched live signal locally.
 *
 * S1: every call carries an explicit `timeoutMs`. S5: every mutation runs inside
 * the per-adapter lock. S7: every mutation stamps a pending record for exactly
 * the window it is in flight. S4: nothing is caught silently.
 */

import type {
	DbusTransport,
	DbusValue,
	SignalEvent,
	Subscription,
} from "@ceralive/modem-control/transport";
import { variant } from "@ceralive/modem-control/transport";

import { logger } from "../../helpers/logger.ts";

import { type AdapterLockResult, withAdapterLock } from "./adapter-lock.ts";
import { type BtUnavailable, btUnavailable } from "./bluetooth-availability.ts";
import {
	ADAPTER_IFACE,
	BLUEZ_ROOT_PATH,
	BLUEZ_SERVICE,
	DBUS_CALL_TIMEOUT_MS,
	DBUS_CONNECT_TIMEOUT_MS,
	DBUS_PAIR_TIMEOUT_MS,
	DEVICE_IFACE,
	OBJECT_MANAGER_IFACE,
	PROPERTIES_IFACE,
} from "./bluetooth-constants.ts";
import { adapterPathOf } from "./bluetooth-parsers.ts";
import type {
	BluetoothMutation,
	BluetoothRegistry,
	PendingMutation,
} from "./bluetooth-registry.ts";

// ─── Typed outcomes ───────────────────────────────────────────────────────────

export const BLUETOOTH_REFUSALS = [
	/** Another mutation holds this adapter (S5) — refused, never queued. */
	"adapter_busy",
	/** The object path names no device this registry knows. */
	"unknown_device",
	/** The object path names no adapter this registry knows. */
	"unknown_adapter",
	/** The client has not connected (or has been torn down). */
	"not_connected",
	/** BlueZ answered a D-Bus error; `bluezError` carries its name. */
	"bluez_error",
] as const;

export type BluetoothRefusalCode = (typeof BLUETOOTH_REFUSALS)[number];

export interface BluetoothRefusal {
	readonly ok: false;
	readonly error: BluetoothRefusalCode;
	/** The mutation holding the adapter, for `adapter_busy`. */
	readonly heldBy?: BluetoothMutation;
	/** The `org.bluez.Error.*` name when BlueZ named one. */
	readonly bluezError?: string;
	readonly detail?: string;
}

export type BluetoothResult<T> =
	| { readonly ok: true; readonly value: T }
	| BluetoothRefusal
	| BtUnavailable;

/**
 * NAMED parser for a BlueZ D-Bus rejection (S2).
 *
 * The rejection can arrive as an `Error` whose `name` IS the D-Bus error name,
 * as an object carrying `dbusName`/`errorName`, or as a message that merely
 * mentions it — so the name is looked for in each, in that order, and a
 * rejection that names none answers `undefined` rather than a guess. The
 * `org.bluez.Error.` prefix is required: a plain `TypeError` must never be
 * reported to an operator as a Bluetooth refusal reason.
 */
export function parseBluezErrorName(err: unknown): string | undefined {
	const BLUEZ_ERROR_RE = /org\.bluez\.Error\.[A-Za-z]+/;
	const candidate = err as
		| {
				name?: unknown;
				dbusName?: unknown;
				errorName?: unknown;
				message?: unknown;
		  }
		| null
		| undefined;
	if (candidate === null || candidate === undefined) return undefined;

	for (const field of [
		candidate.name,
		candidate.dbusName,
		candidate.errorName,
		candidate.message,
	]) {
		if (typeof field !== "string") continue;
		const match = BLUEZ_ERROR_RE.exec(field);
		if (match !== null) return match[0];
	}
	return undefined;
}

function bluezRefusal(err: unknown): BluetoothRefusal {
	const name = parseBluezErrorName(err);
	return name === undefined
		? { ok: false, error: "bluez_error", detail: String(err) }
		: {
				ok: false,
				error: "bluez_error",
				bluezError: name,
				detail: String(err),
			};
}

// ─── Client ───────────────────────────────────────────────────────────────────

export interface BluezClientDeps {
	readonly transport: DbusTransport;
	readonly registry: BluetoothRegistry;
	/** Fired on every registry edge, so the caller can broadcast on change only. */
	readonly onChange?: () => void;
	readonly log?: (msg: string) => void;
	readonly warn?: (msg: string) => void;
}

export interface DiscoveryFilter {
	/** `auto` (default), `bredr`, or `le`. */
	readonly transport?: "auto" | "bredr" | "le";
	/** Only report devices at or above this RSSI. */
	readonly rssi?: number;
	/** Service UUIDs to restrict the scan to. */
	readonly uuids?: readonly string[];
}

export interface BluezClient {
	connect(): Promise<BluetoothResult<{ adapters: readonly string[] }>>;
	disconnect(): Promise<void>;
	refresh(): Promise<BluetoothResult<void>>;
	setPowered(
		adapterPath: string,
		powered: boolean,
	): Promise<BluetoothResult<boolean>>;
	startDiscovery(
		adapterPath: string,
		filter?: DiscoveryFilter,
	): Promise<BluetoothResult<void>>;
	stopDiscovery(adapterPath: string): Promise<BluetoothResult<void>>;
	pair(devicePath: string): Promise<BluetoothResult<void>>;
	setTrusted(
		devicePath: string,
		trusted: boolean,
	): Promise<BluetoothResult<boolean>>;
	forget(devicePath: string): Promise<BluetoothResult<void>>;
	connectDevice(devicePath: string): Promise<BluetoothResult<void>>;
	disconnectDevice(devicePath: string): Promise<BluetoothResult<void>>;
}

export function createBluezClient(deps: BluezClientDeps): BluezClient {
	const log = deps.log ?? ((m: string) => logger.info(m));
	const warn = deps.warn ?? ((m: string) => logger.warn(m));
	const { transport, registry } = deps;

	let subscriptions: Subscription[] = [];
	let connected = false;

	const notify = (changed: boolean): void => {
		if (changed) deps.onChange?.();
	};

	const onInterfacesAdded = (event: SignalEvent): void => {
		const [path, interfaces] = event.body;
		notify(
			registry.applyInterfacesAdded(path as DbusValue, interfaces as DbusValue),
		);
	};

	const onInterfacesRemoved = (event: SignalEvent): void => {
		const [path, interfaces] = event.body;
		notify(
			registry.applyInterfacesRemoved(
				path as DbusValue,
				interfaces as DbusValue,
			),
		);
	};

	const onPropertiesChanged = (event: SignalEvent): void => {
		const [iface, changed, invalidated] = event.body;
		notify(
			registry.applyPropertiesChanged(
				event.path,
				iface as DbusValue,
				changed as DbusValue,
				invalidated as DbusValue,
			),
		);
	};

	async function fetchSnapshot(): Promise<void> {
		const reply = await transport.callMethod({
			destination: BLUEZ_SERVICE,
			path: BLUEZ_ROOT_PATH,
			interface: OBJECT_MANAGER_IFACE,
			member: "GetManagedObjects",
			timeoutMs: DBUS_CALL_TIMEOUT_MS,
		});
		registry.applyManagedObjectsBody(reply.body[0]);
	}

	/** Resolve the adapter a mutation contends for; `undefined` when unknowable. */
	function resolveAdapter(devicePath: string): string | undefined {
		const known = registry.device(devicePath);
		return known?.adapterPath ?? adapterPathOf(devicePath);
	}

	/**
	 * Every device mutation funnels through here, so the S5 lock and the S7
	 * pending stamp cannot be bypassed by adding a method.
	 */
	async function mutateDevice<T>(
		devicePath: string,
		op: BluetoothMutation,
		run: () => Promise<T>,
	): Promise<BluetoothResult<T>> {
		if (!connected) return { ok: false, error: "not_connected" };
		if (registry.device(devicePath) === undefined) {
			return { ok: false, error: "unknown_device", detail: devicePath };
		}
		const adapterPath = resolveAdapter(devicePath);
		if (adapterPath === undefined) {
			return { ok: false, error: "unknown_adapter", detail: devicePath };
		}

		const stamp = (pending: PendingMutation | undefined): void => {
			registry.setDevicePending(devicePath, pending);
			deps.onChange?.();
		};

		let outcome: AdapterLockResult<BluetoothResult<T>>;
		try {
			outcome = await withAdapterLock(
				adapterPath,
				op,
				async () => {
					try {
						return { ok: true as const, value: await run() };
					} catch (err) {
						warn(`bluetooth: ${op} failed for ${devicePath}: ${String(err)}`);
						return bluezRefusal(err);
					}
				},
				stamp,
			);
		} catch (err) {
			// The lock releases in its own `finally`; reaching here means the
			// stamp callback itself threw, which must not be swallowed.
			warn(`bluetooth: ${op} aborted for ${devicePath}: ${String(err)}`);
			return { ok: false, error: "bluez_error", detail: String(err) };
		}

		if (!outcome.success) {
			return { ok: false, error: "adapter_busy", heldBy: outcome.heldBy };
		}
		return outcome.result;
	}

	async function mutateAdapter<T>(
		adapterPath: string,
		op: BluetoothMutation,
		run: () => Promise<T>,
	): Promise<BluetoothResult<T>> {
		if (!connected) return { ok: false, error: "not_connected" };
		if (registry.adapter(adapterPath) === undefined) {
			return { ok: false, error: "unknown_adapter", detail: adapterPath };
		}

		const stamp = (pending: PendingMutation | undefined): void => {
			registry.setAdapterPending(adapterPath, pending);
			deps.onChange?.();
		};

		const outcome = await withAdapterLock(
			adapterPath,
			op,
			async () => {
				try {
					return { ok: true as const, value: await run() };
				} catch (err) {
					warn(`bluetooth: ${op} failed for ${adapterPath}: ${String(err)}`);
					return bluezRefusal(err);
				}
			},
			stamp,
		);

		if (!outcome.success) {
			return { ok: false, error: "adapter_busy", heldBy: outcome.heldBy };
		}
		return outcome.result;
	}

	function setProperty(
		path: string,
		iface: string,
		name: string,
		signature: string,
		value: DbusValue,
	): Promise<unknown> {
		return transport.callMethod({
			destination: BLUEZ_SERVICE,
			path,
			interface: PROPERTIES_IFACE,
			member: "Set",
			signature: "ssv",
			args: [iface, name, variant(signature, value)],
			timeoutMs: DBUS_CALL_TIMEOUT_MS,
		});
	}

	return {
		async connect(): Promise<BluetoothResult<{ adapters: readonly string[] }>> {
			try {
				await transport.connect();
			} catch (err) {
				warn(`bluetooth: could not reach the system bus: ${String(err)}`);
				return btUnavailable("bus_unreachable", String(err));
			}

			// Subscribe BEFORE snapshotting — see the module header.
			try {
				subscriptions = await Promise.all([
					transport.subscribeSignal(
						{
							interface: OBJECT_MANAGER_IFACE,
							member: "InterfacesAdded",
						},
						onInterfacesAdded,
					),
					transport.subscribeSignal(
						{
							interface: OBJECT_MANAGER_IFACE,
							member: "InterfacesRemoved",
						},
						onInterfacesRemoved,
					),
					transport.subscribeSignal(
						{
							interface: PROPERTIES_IFACE,
							member: "PropertiesChanged",
						},
						onPropertiesChanged,
					),
				]);
			} catch (err) {
				warn(`bluetooth: could not subscribe to BlueZ signals: ${String(err)}`);
				await this.disconnect();
				return btUnavailable("bluez_unavailable", String(err));
			}

			try {
				await fetchSnapshot();
			} catch (err) {
				warn(`bluetooth: GetManagedObjects failed: ${String(err)}`);
				await this.disconnect();
				return btUnavailable("bluez_unavailable", String(err));
			}

			const adapters = registry.adapterPaths();
			if (adapters.length === 0) {
				// BlueZ is up and answered; the board simply has no controller.
				// That is a DIFFERENT fact from "bluetoothd is not running", and
				// collapsing them would send an operator to restart a healthy
				// service over missing hardware.
				await this.disconnect();
				return btUnavailable("no_adapter", "BlueZ exposes no Adapter1");
			}

			connected = true;
			deps.onChange?.();
			log(`bluetooth: BlueZ observed with ${adapters.length} adapter(s)`);
			return { ok: true, value: { adapters } };
		},

		async disconnect(): Promise<void> {
			connected = false;
			const held = subscriptions;
			subscriptions = [];
			for (const sub of held) {
				await sub.unsubscribe().catch((err: unknown) => {
					warn(`bluetooth: unsubscribe failed: ${String(err)}`);
				});
			}
			await transport.disconnect().catch((err: unknown) => {
				warn(`bluetooth: transport disconnect failed: ${String(err)}`);
			});
		},

		async refresh(): Promise<BluetoothResult<void>> {
			if (!connected) return { ok: false, error: "not_connected" };
			try {
				await fetchSnapshot();
				deps.onChange?.();
				return { ok: true, value: undefined };
			} catch (err) {
				warn(`bluetooth: refresh failed: ${String(err)}`);
				return bluezRefusal(err);
			}
		},

		setPowered(adapterPath, powered) {
			return mutateAdapter(adapterPath, "power", async () => {
				await setProperty(adapterPath, ADAPTER_IFACE, "Powered", "b", powered);
				return powered;
			});
		},

		startDiscovery(adapterPath, filter) {
			return mutateAdapter(adapterPath, "discovery", async () => {
				const entries: DbusValue[] = [
					["Transport", variant("s", filter?.transport ?? "auto")],
					// Duplicate advertisements add nothing to a registry keyed on
					// object path, and they cost a signal per advertisement.
					["DuplicateData", variant("b", false)],
				];
				if (filter?.rssi !== undefined) {
					entries.push(["RSSI", variant("n", filter.rssi)]);
				}
				if (filter?.uuids !== undefined && filter.uuids.length > 0) {
					entries.push(["UUIDs", variant("as", [...filter.uuids])]);
				}
				await transport.callMethod({
					destination: BLUEZ_SERVICE,
					path: adapterPath,
					interface: ADAPTER_IFACE,
					member: "SetDiscoveryFilter",
					signature: "a{sv}",
					args: [entries],
					timeoutMs: DBUS_CALL_TIMEOUT_MS,
				});
				await transport.callMethod({
					destination: BLUEZ_SERVICE,
					path: adapterPath,
					interface: ADAPTER_IFACE,
					member: "StartDiscovery",
					timeoutMs: DBUS_CALL_TIMEOUT_MS,
				});
			});
		},

		stopDiscovery(adapterPath) {
			return mutateAdapter(adapterPath, "discovery", async () => {
				await transport.callMethod({
					destination: BLUEZ_SERVICE,
					path: adapterPath,
					interface: ADAPTER_IFACE,
					member: "StopDiscovery",
					timeoutMs: DBUS_CALL_TIMEOUT_MS,
				});
			});
		},

		pair(devicePath) {
			return mutateDevice(devicePath, "pair", async () => {
				await transport.callMethod({
					destination: BLUEZ_SERVICE,
					path: devicePath,
					interface: DEVICE_IFACE,
					member: "Pair",
					// Longer than every other call on this path: BlueZ owns its own
					// pairing timeout and answering before it does would report an
					// in-progress pairing as failed.
					timeoutMs: DBUS_PAIR_TIMEOUT_MS,
				});
			});
		},

		setTrusted(devicePath, trusted) {
			return mutateDevice(
				devicePath,
				trusted ? "trust" : "untrust",
				async () => {
					// IDEMPOTENT BY CONSTRUCTION: `Properties.Set` on an unchanged
					// value is a no-op for BlueZ, so a repeat trust needs no
					// read-compare and cannot answer AlreadyExists.
					await setProperty(devicePath, DEVICE_IFACE, "Trusted", "b", trusted);
					return trusted;
				},
			);
		},

		forget(devicePath) {
			const adapterPath = resolveAdapter(devicePath);
			return mutateDevice(devicePath, "forget", async () => {
				if (adapterPath === undefined) {
					throw new Error(`no adapter owns ${devicePath}`);
				}
				await transport.callMethod({
					destination: BLUEZ_SERVICE,
					path: adapterPath,
					interface: ADAPTER_IFACE,
					member: "RemoveDevice",
					signature: "o",
					args: [devicePath],
					timeoutMs: DBUS_CALL_TIMEOUT_MS,
				});
			});
		},

		connectDevice(devicePath) {
			return mutateDevice(devicePath, "connect", async () => {
				await transport.callMethod({
					destination: BLUEZ_SERVICE,
					path: devicePath,
					interface: DEVICE_IFACE,
					member: "Connect",
					timeoutMs: DBUS_CONNECT_TIMEOUT_MS,
				});
			});
		},

		disconnectDevice(devicePath) {
			return mutateDevice(devicePath, "disconnect", async () => {
				await transport.callMethod({
					destination: BLUEZ_SERVICE,
					path: devicePath,
					interface: DEVICE_IFACE,
					member: "Disconnect",
					timeoutMs: DBUS_CONNECT_TIMEOUT_MS,
				});
			});
		},
	};
}
