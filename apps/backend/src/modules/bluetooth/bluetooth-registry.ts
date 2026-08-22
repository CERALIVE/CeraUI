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
 * The BlueZ object registry — `GetManagedObjects` + `InterfacesAdded` /
 * `InterfacesRemoved` / `PropertiesChanged` folded into adapter and device rows.
 *
 * PURE: no bus, no spawn, no clock (the pending-state stamp is passed in). It is
 * the direct twin of the cellular path's `dbus-view-fold.ts` — same decode
 * helpers, from the SAME package (`asManagedObjects` / `findInterface` /
 * `propValue` / `stringProp` / `numberProp`), so there is exactly one D-Bus
 * decode layer in this backend and not two.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A SIGNAL IS A DELTA, AND A DELTA MUST NOT INVENT A ROW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `PropertiesChanged` carries only what MOVED, so folding it onto a row this
 * registry has never seen would mint a device from a partial view — no address,
 * no UUIDs, and therefore a `deviceClass` of `unknown` that a later
 * `InterfacesAdded` would have to correct. BlueZ always announces an object
 * through `InterfacesAdded` (or the initial snapshot) before it publishes a
 * property change for it, so a change for an unknown path is DROPPED, not
 * adopted. `applyPropertiesChanged` returns `false` for it, which is also how
 * the caller knows nothing needs re-broadcasting.
 *
 * `InterfacesRemoved` is the inverse and is NOT a whole-object delete: BlueZ
 * uses it to retract ONE interface (a `Battery1` that went away when a headset
 * disconnected) as readily as the whole device. Only the removal of
 * `org.bluez.Device1` retires the row; anything else strips just that facet.
 */

import {
	asManagedObjects,
	type DecodedManagedObjects,
	type DecodedProps,
	findInterface,
	numberProp,
	pathsWithInterface,
	propValue,
	stringProp,
} from "@ceralive/modem-control";
import {
	type DbusValue,
	type DbusVariant,
	isVariant,
} from "@ceralive/modem-control/transport";

import {
	type BluetoothCapability,
	type BluetoothDeviceClass,
	deriveCapability,
} from "./bluetooth-classes.ts";
import {
	ADAPTER_IFACE,
	BATTERY_IFACE,
	DEVICE_IFACE,
} from "./bluetooth-constants.ts";
import {
	adapterPathOf,
	asBatteryPercentage,
	asBoolean,
	asStringArray,
	isObjectPath,
} from "./bluetooth-parsers.ts";

/** Mutations that can be in flight against one object (S7 pending states). */
export type BluetoothMutation =
	| "pair"
	| "trust"
	| "untrust"
	| "forget"
	| "connect"
	| "disconnect"
	| "power"
	| "discovery";

/** A journal-style pending record: WHAT is in flight and since WHEN. */
export interface PendingMutation {
	readonly op: BluetoothMutation;
	readonly startedAtMs: number;
}

export interface BluetoothAdapterRow {
	readonly path: string;
	readonly address: string | undefined;
	readonly name: string | undefined;
	readonly powered: boolean;
	readonly discovering: boolean;
	readonly discoverable: boolean;
	readonly pairable: boolean;
	readonly pending: PendingMutation | undefined;
}

export interface BluetoothDeviceRow {
	readonly path: string;
	/** The adapter that owns this device, derived from the object path. */
	readonly adapterPath: string | undefined;
	readonly address: string | undefined;
	/** `Alias` when the operator/BlueZ set one, else `Name`. */
	readonly name: string | undefined;
	readonly paired: boolean;
	readonly trusted: boolean;
	readonly connected: boolean;
	readonly blocked: boolean;
	/** Advertisement RSSI when BlueZ is publishing one (discovery only). */
	readonly rssi: number | undefined;
	readonly uuids: readonly string[];
	readonly deviceClass: BluetoothDeviceClass;
	/** HFP/HSP ONLY — see `bluetooth-classes.ts`. Never "has an audio UUID". */
	readonly scoCapable: boolean;
	/** `Battery1.Percentage`, present only when the device exposes it. */
	readonly batteryPercentage: number | undefined;
	readonly pending: PendingMutation | undefined;
}

/** Mutable interior state — a row is rebuilt from it on every read. */
interface DeviceState {
	address: string | undefined;
	name: string | undefined;
	alias: string | undefined;
	paired: boolean;
	trusted: boolean;
	connected: boolean;
	blocked: boolean;
	rssi: number | undefined;
	uuids: readonly string[];
	battery: number | undefined;
	pending: PendingMutation | undefined;
}

interface AdapterState {
	address: string | undefined;
	name: string | undefined;
	powered: boolean;
	discovering: boolean;
	discoverable: boolean;
	pairable: boolean;
	pending: PendingMutation | undefined;
}

/** Normalise a raw `a{sv}` D-Bus value into the package's `DecodedProps` shape. */
export function asProps(value: DbusValue | undefined): DecodedProps {
	if (!Array.isArray(value)) return [];
	const out: Array<readonly [string, DbusVariant]> = [];
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const [name, variant] = entry;
		if (typeof name !== "string") continue;
		if (variant !== undefined && isVariant(variant)) out.push([name, variant]);
	}
	return out;
}

/** Normalise a raw `a{sa{sv}}` interfaces value into `[iface, props][]`. */
function asInterfaceEntries(
	value: DbusValue | undefined,
): Array<readonly [string, DecodedProps]> {
	if (!Array.isArray(value)) return [];
	const out: Array<readonly [string, DecodedProps]> = [];
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const [iface, props] = entry;
		if (typeof iface !== "string") continue;
		out.push([iface, asProps(props)]);
	}
	return out;
}

function emptyDevice(): DeviceState {
	return {
		address: undefined,
		name: undefined,
		alias: undefined,
		paired: false,
		trusted: false,
		connected: false,
		blocked: false,
		rssi: undefined,
		uuids: [],
		battery: undefined,
		pending: undefined,
	};
}

function emptyAdapter(): AdapterState {
	return {
		address: undefined,
		name: undefined,
		powered: false,
		discovering: false,
		discoverable: false,
		pairable: false,
		pending: undefined,
	};
}

/**
 * Merge one `Device1` property set onto a device's state.
 *
 * Only properties PRESENT in `props` are written — a `PropertiesChanged` carries
 * a delta, so an absent key means "unchanged", never "false". Writing a default
 * for an absent key is how a headset that merely reported a new RSSI would be
 * published as un-paired and un-trusted.
 */
function mergeDeviceProps(state: DeviceState, props: DecodedProps): void {
	const address = stringProp(props, "Address");
	if (address !== undefined) state.address = address;

	const name = stringProp(props, "Name");
	if (name !== undefined) state.name = name;

	const alias = stringProp(props, "Alias");
	if (alias !== undefined) state.alias = alias;

	const paired = asBoolean(propValue(props, "Paired"));
	if (paired !== undefined) state.paired = paired;

	const trusted = asBoolean(propValue(props, "Trusted"));
	if (trusted !== undefined) state.trusted = trusted;

	const connected = asBoolean(propValue(props, "Connected"));
	if (connected !== undefined) state.connected = connected;

	const blocked = asBoolean(propValue(props, "Blocked"));
	if (blocked !== undefined) state.blocked = blocked;

	const rssi = numberProp(props, "RSSI");
	if (rssi !== undefined) state.rssi = rssi;

	const uuids = asStringArray(propValue(props, "UUIDs"));
	if (uuids !== undefined) state.uuids = uuids;
}

function mergeAdapterProps(state: AdapterState, props: DecodedProps): void {
	const address = stringProp(props, "Address");
	if (address !== undefined) state.address = address;

	const name = stringProp(props, "Alias") ?? stringProp(props, "Name");
	if (name !== undefined) state.name = name;

	const powered = asBoolean(propValue(props, "Powered"));
	if (powered !== undefined) state.powered = powered;

	const discovering = asBoolean(propValue(props, "Discovering"));
	if (discovering !== undefined) state.discovering = discovering;

	const discoverable = asBoolean(propValue(props, "Discoverable"));
	if (discoverable !== undefined) state.discoverable = discoverable;

	const pairable = asBoolean(propValue(props, "Pairable"));
	if (pairable !== undefined) state.pairable = pairable;
}

function mergeBatteryProps(state: DeviceState, props: DecodedProps): void {
	const pct = asBatteryPercentage(propValue(props, "Percentage"));
	if (pct !== undefined) state.battery = pct;
}

/**
 * The fold. Holds adapters and devices keyed by object path and answers rows.
 *
 * Every mutator returns whether it CHANGED anything, so the composition root can
 * broadcast on a real edge instead of on every signal — the same on-change
 * cadence the `sources` broadcast follows.
 */
export class BluetoothRegistry {
	readonly #adapters = new Map<string, AdapterState>();
	readonly #devices = new Map<string, DeviceState>();

	/** Adopt a full `GetManagedObjects` tree, REPLACING everything known. */
	applySnapshot(tree: DecodedManagedObjects): void {
		const pendingAdapters = new Map<string, PendingMutation | undefined>();
		for (const [path, state] of this.#adapters) {
			pendingAdapters.set(path, state.pending);
		}
		const pendingDevices = new Map<string, PendingMutation | undefined>();
		for (const [path, state] of this.#devices) {
			pendingDevices.set(path, state.pending);
		}

		this.#adapters.clear();
		this.#devices.clear();

		for (const path of pathsWithInterface(tree, ADAPTER_IFACE)) {
			const state = emptyAdapter();
			mergeAdapterProps(state, findInterface(tree, path, ADAPTER_IFACE) ?? []);
			// A mutation in flight across a resnapshot is still in flight — the
			// snapshot describes the DEVICE, not our own outstanding work.
			state.pending = pendingAdapters.get(path);
			this.#adapters.set(path, state);
		}

		for (const path of pathsWithInterface(tree, DEVICE_IFACE)) {
			const state = emptyDevice();
			mergeDeviceProps(state, findInterface(tree, path, DEVICE_IFACE) ?? []);
			const battery = findInterface(tree, path, BATTERY_IFACE);
			if (battery !== undefined) mergeBatteryProps(state, battery);
			state.pending = pendingDevices.get(path);
			this.#devices.set(path, state);
		}
	}

	/**
	 * Adopt a raw `GetManagedObjects` reply body value (the `a{oa{sa{sv}}}`
	 * payload) — the shape the transport hands back.
	 */
	applyManagedObjectsBody(value: DbusValue | undefined): void {
		this.applySnapshot(asManagedObjects(value));
	}

	/** Fold an `InterfacesAdded(path, interfaces)` signal. */
	applyInterfacesAdded(path: DbusValue, interfaces: DbusValue): boolean {
		if (!isObjectPath(path)) return false;
		const entries = asInterfaceEntries(interfaces);
		let changed = false;

		for (const [iface, props] of entries) {
			if (iface === ADAPTER_IFACE) {
				const state = this.#adapters.get(path) ?? emptyAdapter();
				mergeAdapterProps(state, props);
				this.#adapters.set(path, state);
				changed = true;
			} else if (iface === DEVICE_IFACE) {
				const state = this.#devices.get(path) ?? emptyDevice();
				mergeDeviceProps(state, props);
				this.#devices.set(path, state);
				changed = true;
			} else if (iface === BATTERY_IFACE) {
				// A Battery1 can arrive on its OWN InterfacesAdded, after the
				// Device1 that owns it — so it must attach to an existing row.
				const state = this.#devices.get(path);
				if (state !== undefined) {
					mergeBatteryProps(state, props);
					changed = true;
				}
			}
		}
		return changed;
	}

	/**
	 * Fold an `InterfacesRemoved(path, interfaces)` signal.
	 *
	 * Removing `Device1` retires the row. Removing `Battery1` alone strips only
	 * the battery reading — a disconnected headset legitimately loses its battery
	 * interface while the paired device row stays.
	 */
	applyInterfacesRemoved(path: DbusValue, interfaces: DbusValue): boolean {
		if (!isObjectPath(path)) return false;
		const names = asStringArray(interfaces) ?? [];
		let changed = false;

		for (const iface of names) {
			if (iface === DEVICE_IFACE) {
				changed = this.#devices.delete(path) || changed;
			} else if (iface === ADAPTER_IFACE) {
				changed = this.#adapters.delete(path) || changed;
			} else if (iface === BATTERY_IFACE) {
				const state = this.#devices.get(path);
				if (state !== undefined && state.battery !== undefined) {
					state.battery = undefined;
					changed = true;
				}
			}
		}
		return changed;
	}

	/**
	 * Fold a `PropertiesChanged(iface, changed, invalidated)` signal.
	 *
	 * A change for a path this registry has never seen is DROPPED — see the
	 * module header. `invalidated` clears the named properties rather than
	 * leaving a stale value standing.
	 */
	applyPropertiesChanged(
		path: string,
		iface: DbusValue,
		changed: DbusValue,
		invalidated?: DbusValue,
	): boolean {
		if (!isObjectPath(path) || typeof iface !== "string") return false;
		const props = asProps(changed);
		const dropped = asStringArray(invalidated) ?? [];

		if (iface === ADAPTER_IFACE) {
			const state = this.#adapters.get(path);
			if (state === undefined) return false;
			mergeAdapterProps(state, props);
			for (const name of dropped) {
				if (name === "Discovering") state.discovering = false;
				if (name === "Powered") state.powered = false;
			}
			return props.length > 0 || dropped.length > 0;
		}

		if (iface === DEVICE_IFACE) {
			const state = this.#devices.get(path);
			if (state === undefined) return false;
			mergeDeviceProps(state, props);
			for (const name of dropped) {
				if (name === "RSSI") state.rssi = undefined;
				if (name === "Connected") state.connected = false;
			}
			return props.length > 0 || dropped.length > 0;
		}

		if (iface === BATTERY_IFACE) {
			const state = this.#devices.get(path);
			if (state === undefined) return false;
			mergeBatteryProps(state, props);
			if (dropped.includes("Percentage")) state.battery = undefined;
			return props.length > 0 || dropped.length > 0;
		}

		return false;
	}

	// ─── Pending states (S7) ────────────────────────────────────────────────────

	/** Mark a mutation in flight against a device row (no-op for unknown paths). */
	setDevicePending(path: string, pending: PendingMutation | undefined): void {
		const state = this.#devices.get(path);
		if (state !== undefined) state.pending = pending;
	}

	/** Mark a mutation in flight against an adapter row. */
	setAdapterPending(path: string, pending: PendingMutation | undefined): void {
		const state = this.#adapters.get(path);
		if (state !== undefined) state.pending = pending;
	}

	// ─── Reads ─────────────────────────────────────────────────────────────────

	adapterPaths(): string[] {
		return [...this.#adapters.keys()];
	}

	adapter(path: string): BluetoothAdapterRow | undefined {
		const state = this.#adapters.get(path);
		return state === undefined ? undefined : { path, ...state };
	}

	adapters(): BluetoothAdapterRow[] {
		return [...this.#adapters.entries()].map(([path, state]) => ({
			path,
			...state,
		}));
	}

	device(path: string): BluetoothDeviceRow | undefined {
		const state = this.#devices.get(path);
		return state === undefined ? undefined : buildDeviceRow(path, state);
	}

	devices(): BluetoothDeviceRow[] {
		return [...this.#devices.entries()].map(([path, state]) =>
			buildDeviceRow(path, state),
		);
	}

	/** Trusted-and-not-connected devices, in wire order — the boot-reconnect set. */
	reconnectCandidates(): BluetoothDeviceRow[] {
		return this.devices().filter((d) => d.trusted && d.paired && !d.connected);
	}

	reset(): void {
		this.#adapters.clear();
		this.#devices.clear();
	}
}

function buildDeviceRow(path: string, state: DeviceState): BluetoothDeviceRow {
	const capability: BluetoothCapability = deriveCapability(state.uuids);
	return {
		path,
		adapterPath: adapterPathOf(path),
		address: state.address,
		name: state.alias ?? state.name,
		paired: state.paired,
		trusted: state.trusted,
		connected: state.connected,
		blocked: state.blocked,
		rssi: state.rssi,
		uuids: state.uuids,
		deviceClass: capability.deviceClass,
		scoCapable: capability.scoCapable,
		batteryPercentage: state.battery,
		pending: state.pending,
	};
}
