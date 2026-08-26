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
 * Builders for a decoded `GetManagedObjects` payload.
 *
 * The transport decodes `a{oa{sa{sv}}}` into nested TUPLE ARRAYS — a dict is
 * `[key, value][]` and a variant is `{signature, value}` — so a plain object
 * literal would not resemble what the real bus delivers. These builders emit
 * that exact shape, which is what makes a fold test meaningful rather than a
 * test of a convenient fixture.
 */

import type { DecodedManagedObjects } from "@ceralive/modem-control";
import type { DbusValue } from "@ceralive/modem-control/transport";

/** MMModemState / mode / access-tech constants used by the fixtures. */
export const MM_STATE_CONNECTED = 11;
export const MM_STATE_SEARCHING = 7;
export const MM_MODE_4G = 1 << 3;
export const MM_MODE_5G = 1 << 4;
export const MM_ACCESS_TECH_LTE = 1 << 14;
export const MM_REG_HOME = 1;
export const MM_LOCK_NONE = 1;

const MODEM_IFACE = "org.freedesktop.ModemManager1.Modem";
const MODEM3GPP_IFACE = "org.freedesktop.ModemManager1.Modem.Modem3gpp";
const MODEM_SIGNAL_IFACE = "org.freedesktop.ModemManager1.Modem.Signal";
const MODEM_LOCATION_IFACE = "org.freedesktop.ModemManager1.Modem.Location";
const SIM_IFACE = "org.freedesktop.ModemManager1.Sim";

/** MMModemState `FAILED_REASON_SIM_MISSING`, as `Modem.StateFailedReason` reports it. */
export const MM_FAILED_REASON_SIM_MISSING = 2;

/** `MM_MODEM_LOCATION_SOURCE_3GPP_LAC_CI` — the key of a coarse-cell entry. */
export const MM_LOCATION_SOURCE_3GPP_LAC_CI = 1;

export interface ModemFixture {
	readonly path: string;
	readonly ifname?: string;
	readonly state?: number;
	readonly signal?: number;
	readonly operatorName?: string;
	readonly model?: string;
	readonly manufacturer?: string;
	readonly equipmentId?: string;
	readonly physdev?: string;
	readonly registrationState?: number;
	readonly accessTechnologies?: number;
	readonly supportedModes?: readonly number[];
	readonly currentModes?: number;
	readonly unlockRequired?: number;
	readonly unlockRetries?: readonly (readonly [number, number])[];
	readonly revision?: string;
	readonly ownNumbers?: readonly string[];
	readonly simPath?: string;
	/** `Sim.SimIdentifier`. An empty string is MM's "the card withheld it". */
	readonly iccid?: string;
	readonly simType?: number;
	readonly esimStatus?: number;
	readonly packetServiceState?: number;
	/** `Modem.PowerState` (`MMModemPowerState`). Omitted ⇒ the property is absent. */
	readonly powerState?: number;
	readonly operatorCode?: string;
	/** The `b` of `Modem.SignalQuality`'s `(ub)` — was it measured recently. */
	readonly signalRecent?: boolean;
	/** Suppress `Modem.SignalQuality` entirely, so the read has nothing to answer. */
	readonly omitSignalQuality?: boolean;
	/**
	 * The `Modem.Signal` interface's per-RAT `a{sv}` properties, keyed by MM's
	 * own property names (`Nr5g` / `Lte` / `Evdo` / …). Omitting the whole field
	 * omits the INTERFACE — which is what an unprimed observation looks like and
	 * is a different fact from a primed interface whose dicts are empty.
	 */
	readonly extendedSignal?: Readonly<
		Record<string, Readonly<Record<string, DbusValue>>>
	>;
	/**
	 * A `Modem.Location` `a{uv}` entry set. Omitting it omits the INTERFACE; MM
	 * masks the property itself unless a location source is enabled, so an empty
	 * record models an exposed-but-silent interface.
	 */
	readonly location?: Readonly<Record<number, DbusValue>>;
	/** `Modem.SimSlots` (`ao`). An EMPTY slot is the bare root path `/`. */
	readonly simSlots?: readonly string[];
	/** `Modem.StateFailedReason` (`MMModemStateFailedReason`). */
	readonly stateFailedReason?: number;
	readonly networkRejection?: {
		readonly error: number;
		readonly operatorId?: string;
		readonly operatorName?: string;
		readonly accessTechnology?: number;
	};
}

function v(
	signature: string,
	value: DbusValue,
): { signature: string; value: DbusValue } {
	return { signature, value };
}

function modemProps(fixture: ModemFixture): [string, ReturnType<typeof v>][] {
	const props: [string, ReturnType<typeof v>][] = [
		["State", v("i", fixture.state ?? MM_STATE_CONNECTED)],
		...(fixture.omitSignalQuality === true
			? []
			: ([
					[
						"SignalQuality",
						v("(ub)", [fixture.signal ?? 72, fixture.signalRecent ?? true]),
					],
				] as [string, ReturnType<typeof v>][])),
		[
			"Ports",
			v("a(su)", [
				["ttyUSB0", 3],
				[fixture.ifname ?? "wwan0", 2],
			]),
		],
		[
			"SupportedModes",
			v(
				"a(uu)",
				(fixture.supportedModes ?? [MM_MODE_4G, MM_MODE_4G | MM_MODE_5G]).map(
					(mask) => [mask, 0],
				),
			),
		],
		[
			"CurrentModes",
			v("(uu)", [fixture.currentModes ?? MM_MODE_4G | MM_MODE_5G, 0]),
		],
		[
			"AccessTechnologies",
			v("u", fixture.accessTechnologies ?? MM_ACCESS_TECH_LTE),
		],
		["UnlockRequired", v("u", fixture.unlockRequired ?? MM_LOCK_NONE)],
	];
	if (fixture.powerState !== undefined) {
		props.push(["PowerState", v("u", fixture.powerState)]);
	}
	if (fixture.unlockRetries !== undefined) {
		props.push([
			"UnlockRetries",
			v(
				"a{uu}",
				fixture.unlockRetries.map(([lock, retries]) => [lock, retries]),
			),
		]);
	}
	if (fixture.model !== undefined) props.push(["Model", v("s", fixture.model)]);
	if (fixture.manufacturer !== undefined) {
		props.push(["Manufacturer", v("s", fixture.manufacturer)]);
	}
	if (fixture.equipmentId !== undefined) {
		props.push(["EquipmentIdentifier", v("s", fixture.equipmentId)]);
	}
	if (fixture.physdev !== undefined) {
		props.push(["Physdev", v("s", fixture.physdev)]);
	}
	if (fixture.revision !== undefined) {
		props.push(["Revision", v("s", fixture.revision)]);
	}
	if (fixture.ownNumbers !== undefined) {
		props.push(["OwnNumbers", v("as", [...fixture.ownNumbers])]);
	}
	if (fixture.simPath !== undefined) {
		props.push(["Sim", v("o", fixture.simPath)]);
	}
	if (fixture.simSlots !== undefined) {
		props.push(["SimSlots", v("ao", [...fixture.simSlots])]);
	}
	if (fixture.stateFailedReason !== undefined) {
		props.push(["StateFailedReason", v("u", fixture.stateFailedReason)]);
	}
	return props;
}

function networkRejectionDict(
	rejection: NonNullable<ModemFixture["networkRejection"]>,
): DbusValue {
	const entries: [string, ReturnType<typeof v>][] = [
		["error", v("u", rejection.error)],
	];
	if (rejection.operatorId !== undefined) {
		entries.push(["operator-id", v("s", rejection.operatorId)]);
	}
	if (rejection.operatorName !== undefined) {
		entries.push(["operator-name", v("s", rejection.operatorName)]);
	}
	if (rejection.accessTechnology !== undefined) {
		entries.push(["access-technology", v("u", rejection.accessTechnology)]);
	}
	return entries as unknown as DbusValue;
}

/** The `a{sv}` tuple form of one per-RAT signal dict. */
function signalDict(members: Readonly<Record<string, DbusValue>>): DbusValue {
	return Object.entries(members).map(([key, value]) => [
		key,
		v(typeof value === "number" ? "d" : "s", value),
	]) as unknown as DbusValue;
}

function signalIfaceProps(
	extended: Readonly<Record<string, Readonly<Record<string, DbusValue>>>>,
): [string, ReturnType<typeof v>][] {
	return Object.entries(extended).map(([rat, members]) => [
		rat,
		v("a{sv}", signalDict(members)),
	]);
}

function locationIfaceProps(
	entries: Readonly<Record<number, DbusValue>>,
): [string, ReturnType<typeof v>][] {
	const dict = Object.entries(entries).map(([key, value]) => [
		Number(key),
		v(typeof value === "string" ? "s" : "v", value),
	]) as unknown as DbusValue;
	return [["Location", v("a{uv}", dict)]];
}

/** One modem object plus (when the fixture names one) its SIM object. */
export function modemObjects(fixture: ModemFixture): DecodedManagedObjects {
	const objects: DecodedManagedObjects = [
		[
			fixture.path,
			[
				[MODEM_IFACE, modemProps(fixture)],
				[
					MODEM3GPP_IFACE,
					[
						[
							"RegistrationState",
							v("u", fixture.registrationState ?? MM_REG_HOME),
						],
						...(fixture.operatorName !== undefined
							? ([["OperatorName", v("s", fixture.operatorName)]] as const)
							: []),
						...(fixture.operatorCode !== undefined
							? ([["OperatorCode", v("s", fixture.operatorCode)]] as const)
							: []),
						...(fixture.packetServiceState !== undefined
							? ([
									["PacketServiceState", v("u", fixture.packetServiceState)],
								] as const)
							: []),
						...(fixture.networkRejection !== undefined
							? ([
									[
										"NetworkRejection",
										v("a{sv}", networkRejectionDict(fixture.networkRejection)),
									],
								] as const)
							: []),
					],
				],
				...(fixture.extendedSignal !== undefined
					? [[MODEM_SIGNAL_IFACE, signalIfaceProps(fixture.extendedSignal)]]
					: []),
				...(fixture.location !== undefined
					? [[MODEM_LOCATION_IFACE, locationIfaceProps(fixture.location)]]
					: []),
			],
		],
	] as unknown as DecodedManagedObjects;

	if (fixture.simPath === undefined) {
		return objects;
	}
	const sim: DecodedManagedObjects = [
		[
			fixture.simPath,
			[
				[
					SIM_IFACE,
					[
						["SimIdentifier", v("s", fixture.iccid ?? "8934071100000000001")],
						["SimType", v("u", fixture.simType ?? 1)],
						...(fixture.esimStatus !== undefined
							? ([["EsimStatus", v("u", fixture.esimStatus)]] as const)
							: []),
					],
				],
			],
		],
	] as unknown as DecodedManagedObjects;
	return [...objects, ...sim];
}

/** A whole `GetManagedObjects` tree from a roster of modem fixtures. */
export function managedObjectsTree(
	fixtures: readonly ModemFixture[],
): DecodedManagedObjects {
	return fixtures.flatMap((fixture) => modemObjects(fixture));
}
