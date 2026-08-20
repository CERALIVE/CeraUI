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
const SIM_IFACE = "org.freedesktop.ModemManager1.Sim";

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
	readonly simPath?: string;
	readonly simType?: number;
	readonly esimStatus?: number;
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
		["SignalQuality", v("(ub)", [fixture.signal ?? 72, true])],
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
	if (fixture.simPath !== undefined) {
		props.push(["Sim", v("o", fixture.simPath)]);
	}
	return props;
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
					],
				],
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
						["SimIdentifier", v("s", "8934071100000000001")],
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
