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
 * The `GetManagedObjects` tree → `DbusModemView[]` fold.
 *
 * PURE. The tree handed to `onEpochRefresh` is the SAME payload the observer
 * reconciled its epoch-authoritative roster from, so it carries both the roster
 * (objects exposing `Modem`) and everything an operator actually looks at —
 * signal, operator name, modes, ports, SIM, eSIM, firmware. The package's own
 * `CellularSnapshot` mapper is deliberately conservative and reports none of the
 * latter, which is why the `ObservationList` is NOT the fold's input: it is used
 * only for the start commit test and for telling the two failure classes apart.
 *
 * A modem the tree cannot fully describe (no `Modem` interface, no net port, an
 * unparseable path) is SKIPPED: half-observed detail on the wire is worse than
 * the mmcli row it would replace. Field-by-field source table:
 * `docs/DBUS-OBSERVATION-CONTRACT.md` §(b).
 */

import {
	type DecodedManagedObjects,
	findInterface,
	followObjectPath,
	MODEM_IFACE,
	MODEM3GPP_IFACE,
	numberProp,
	pathsWithInterface,
	propValue,
	SIM_IFACE,
	stringProp,
} from "@ceralive/modem-control";
import type { DbusValue } from "@ceralive/modem-control/transport";
import { canonicalModemIdPath } from "@ceraui/rpc/schemas";

import type {
	DbusModemView,
	DbusRegistrationView,
} from "../modems/modem-wire-adapters.ts";
import { isSimObjectPath, type SimPresence } from "../modems/sim-presence.ts";

import {
	decodeAccessTechnologies,
	decodeEsimStatus,
	decodeMmState,
	decodeNetworkRejectionError,
	decodePacketServiceState,
	decodeRegistrationState,
	decodeSimType,
	decodeUnlockRequired,
	modeMaskToLabel,
	runtimeIdFromPath,
} from "./dbus-mm-enums.ts";

/** MM_MODEM_PORT_TYPE_NET — the `Modem.Ports` entry that names the data interface. */
const PORT_TYPE_NET = 2;

function firstNumber(value: DbusValue | undefined): number | undefined {
	return Array.isArray(value) && typeof value[0] === "number"
		? value[0]
		: undefined;
}

/** The `net` port of `Modem.Ports` (`a(su)`), or `undefined` when none is exposed. */
function readNetPort(value: DbusValue | undefined): string | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	for (const entry of value) {
		if (!Array.isArray(entry)) continue;
		const [name, type] = entry;
		if (typeof name === "string" && type === PORT_TYPE_NET && name.length > 0) {
			return name;
		}
	}
	return undefined;
}

/** Every mode label in `Modem.SupportedModes` (`a(uu)`), de-duplicated, in order. */
function readSupportedModes(value: DbusValue | undefined): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const labels: string[] = [];
	for (const entry of value) {
		const label = modeMaskToLabel(firstNumber(entry));
		if (label !== undefined && !labels.includes(label)) {
			labels.push(label);
		}
	}
	return labels;
}

/**
 * The `ID_PATH`-equivalent anchor for a modem.
 *
 * `Modem.Physdev` (MM 1.22+) is the physical topology path and is preferred —
 * but MM publishes it as a raw `/sys/devices/...` DEVPATH, NOT as the udev
 * `ID_PATH` every other adapter observes. Two encodings of one socket never
 * compare equal, so the udev provisional row could not be retired by its own
 * authoritative row (todo 24, 10/10 cycles on `ceralive2`).
 * `canonicalModemIdPath` converts it, so the anchor recorded here is in the same
 * vocabulary as every other source's.
 *
 * `Modem.Device` is used only when it is one of OUR `slot-*` udev labels: MM's
 * own default there is the same sysfs path, and preferring it over an absent
 * `Physdev` would anchor on a device node rather than on a port.
 */
function readIdPath(
	physdev: string | undefined,
	device: string | undefined,
): string | undefined {
	if (physdev !== undefined && physdev.length > 0) {
		return canonicalModemIdPath(physdev);
	}
	if (device?.startsWith("slot-")) {
		return device;
	}
	return undefined;
}

function readEsim(
	tree: DecodedManagedObjects,
	modem: ReturnType<typeof findInterface>,
): DbusModemView["esim"] {
	const sim = followObjectPath(tree, modem, "Sim", SIM_IFACE);
	const simType = decodeSimType(numberProp(sim, "SimType"));
	if (simType === undefined) {
		return undefined;
	}
	const esimStatus = decodeEsimStatus(numberProp(sim, "EsimStatus"));
	return simType === "esim" && esimStatus !== undefined
		? { sim_type: simType, esim_status: esimStatus }
		: { sim_type: simType };
}

/**
 * The SIM's ICCID, from the SIM object the modem points at — NOT from the modem
 * itself, which publishes no such property. Board-confirmed on `ceralive2`:
 * `busctl get-property … /SIM/2 …Sim SimIdentifier` answers the same digits
 * `mmcli -i` prints, so the two backends agree by reading one MM fact.
 *
 * A card that has not been read yet answers the empty string, which is absence.
 */
function readIccid(
	tree: DecodedManagedObjects,
	modem: ReturnType<typeof findInterface>,
): string | undefined {
	const sim = followObjectPath(tree, modem, "Sim", SIM_IFACE);
	const iccid = stringProp(sim, "SimIdentifier")?.trim();
	return iccid !== undefined && iccid.length > 0 ? iccid : undefined;
}

/** MM_MODEM_STATE_FAILED_REASON_SIM_MISSING — MM's own "there is no card" value. */
const FAILED_REASON_SIM_MISSING = 2;

/**
 * The D-Bus twin of `sim-presence.ts`'s mmcli rule, reading the SAME three MM
 * facts (`Modem.Sim`, `Modem.SimSlots`, `Modem.StateFailedReason`) so the two
 * backends cannot disagree about whether a modem holds a card. An empty slot is
 * published as the root path `/`, so the object-path SHAPE is the test.
 */
function readSimPresence(modem: ReturnType<typeof findInterface>): SimPresence {
	if (isSimObjectPath(stringProp(modem, "Sim"))) {
		return "present";
	}
	const slots = propValue(modem, "SimSlots");
	if (Array.isArray(slots) && slots.some(isSimObjectPath)) {
		return "present";
	}
	return numberProp(modem, "StateFailedReason") === FAILED_REASON_SIM_MISSING
		? "absent"
		: "unknown";
}

/**
 * One entry of an `a{sv}` property, unwrapped past its variant.
 *
 * The codec decodes a dict to `[key, {signature, value}]` pairs and `propValue`
 * only unwraps the OUTER property variant, so a nested `a{sv}` still carries a
 * variant per value — which is why this cannot reuse `stringProp`/`numberProp`.
 */
function dictEntry(dict: DbusValue | undefined, key: string): unknown {
	if (!Array.isArray(dict)) return undefined;
	for (const entry of dict) {
		if (!Array.isArray(entry) || entry[0] !== key) continue;
		const variant = entry[1];
		return variant !== null && typeof variant === "object" && "value" in variant
			? (variant as { value: unknown }).value
			: variant;
	}
	return undefined;
}

/**
 * The network's own stated reason for refusing registration
 * (`Modem3gpp.NetworkRejection`, `a{sv}`).
 *
 * The mmcli twin of this lives in `modem-registration.ts`, and its anchoring
 * rule is reproduced rather than re-decided: no decodable `error` ⇒ NO rejection
 * at all, because the operator-id / access-technology fields describe nothing an
 * operator could act on without it.
 *
 * WHY IT EXISTS: `"dbus"` is the DEFAULT backend, and this fold published no
 * rejection at all — so the whole `REJECTION_REASON_KEYS` surface the frontend
 * already ships was unreachable on every shipped device. A bench Quectel that
 * ModemManager's own log described as `imsi-unknown-in-hlr` on its home network
 * reached the operator as a bare "Searching…" forever.
 */
function readNetworkRejection(
	modem3gpp: ReturnType<typeof findInterface>,
): DbusModemView["registrationRejection"] {
	const dict = propValue(modem3gpp, "NetworkRejection");
	const raw = dictEntry(dict, "error");
	const error = decodeNetworkRejectionError(
		typeof raw === "number" ? raw : undefined,
	);
	if (error === undefined) return undefined;

	const operatorId = dictEntry(dict, "operator-id");
	const operatorName = dictEntry(dict, "operator-name");
	const rawTech = dictEntry(dict, "access-technology");
	const [accessTechnology] = decodeAccessTechnologies(
		typeof rawTech === "number" ? rawTech : undefined,
	);

	return {
		error,
		...(typeof operatorId === "string" && operatorId.length > 0
			? { operator_id: operatorId }
			: {}),
		...(typeof operatorName === "string" && operatorName.length > 0
			? { operator_name: operatorName }
			: {}),
		...(accessTechnology !== undefined
			? { access_technology: accessTechnology }
			: {}),
	};
}

/**
 * `Modem.OwnNumbers` is `as`. Blank members are dropped and an all-blank list
 * answers `undefined`, so a carrier that published nothing reads as silence
 * rather than as an empty list a consumer could mistake for a finding.
 */
function readOwnNumbers(
	modem: ReturnType<typeof findInterface>,
): string[] | undefined {
	const value = propValue(modem, "OwnNumbers");
	if (!Array.isArray(value)) {
		return undefined;
	}
	const numbers = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return numbers.length > 0 ? numbers : undefined;
}

/** `Modem.UnlockRetries` is `a{uu}`; the retries for the CURRENTLY required lock. */
function readUnlockRetries(
	value: DbusValue | undefined,
	lock: number | undefined,
): number | undefined {
	if (!Array.isArray(value) || lock === undefined) {
		return undefined;
	}
	for (const entry of value) {
		if (!Array.isArray(entry)) continue;
		const [key, retries] = entry;
		if (key === lock && typeof retries === "number") {
			return retries;
		}
	}
	return undefined;
}

/** Fold ONE modem object. Returns `undefined` when the tree cannot describe it. */
function foldOne(
	tree: DecodedManagedObjects,
	modemPath: string,
): DbusModemView | undefined {
	const modem = findInterface(tree, modemPath, MODEM_IFACE);
	if (modem === undefined) {
		return undefined;
	}
	const runtimeId = runtimeIdFromPath(modemPath);
	const ifname = readNetPort(propValue(modem, "Ports"));
	if (runtimeId === undefined || ifname === undefined) {
		return undefined;
	}

	const mmState = decodeMmState(numberProp(modem, "State"));
	const modem3gpp = findInterface(tree, modemPath, MODEM3GPP_IFACE);
	const registration: DbusRegistrationView = {
		status: decodeRegistrationState(numberProp(modem3gpp, "RegistrationState")),
		activeRats: decodeAccessTechnologies(
			numberProp(modem, "AccessTechnologies"),
		),
	};
	const lock = numberProp(modem, "UnlockRequired");
	const simLockRequired = decodeUnlockRequired(lock);
	const retries = readUnlockRetries(propValue(modem, "UnlockRetries"), lock);
	const idPath = readIdPath(
		stringProp(modem, "Physdev"),
		stringProp(modem, "Device"),
	);
	const model = stringProp(modem, "Model");
	const manufacturer = stringProp(modem, "Manufacturer");
	const equipmentId = stringProp(modem, "EquipmentIdentifier");
	const operatorName = stringProp(modem3gpp, "OperatorName");
	const firmwareRevision = stringProp(modem, "Revision");
	const esim = readEsim(tree, modem);
	const simPresence = readSimPresence(modem);
	const ownNumbers = readOwnNumbers(modem);
	const iccid = readIccid(tree, modem);
	const registrationRejection = readNetworkRejection(modem3gpp);
	const packetServiceState = decodePacketServiceState(
		numberProp(modem3gpp, "PacketServiceState"),
	);

	return {
		runtimeId,
		ifname,
		mmState,
		registration,
		// `SignalQuality` is `(ub)`; the boolean says whether it is a recent
		// reading, which the wire has no field for — the percentage is the value.
		signal: firstNumber(propValue(modem, "SignalQuality")) ?? 0,
		supportedNetworkTypes: readSupportedModes(
			propValue(modem, "SupportedModes"),
		),
		activeNetworkType:
			modeMaskToLabel(firstNumber(propValue(modem, "CurrentModes"))) ?? null,
		...(mmState === "searching" ? { scanning: true } : {}),
		...(idPath !== undefined ? { idPath } : {}),
		...(model !== undefined ? { model } : {}),
		...(manufacturer !== undefined ? { manufacturer } : {}),
		...(equipmentId !== undefined && equipmentId.length > 0
			? { equipmentId }
			: {}),
		...(operatorName !== undefined && operatorName.length > 0
			? { operatorName }
			: {}),
		...(firmwareRevision !== undefined && firmwareRevision.length > 0
			? { firmwareRevision }
			: {}),
		...(simPresence !== "unknown" ? { simPresence } : {}),
		...(ownNumbers !== undefined ? { ownNumbers } : {}),
		...(iccid !== undefined ? { iccid } : {}),
		...(registrationRejection !== undefined ? { registrationRejection } : {}),
		...(packetServiceState !== undefined ? { packetServiceState } : {}),
		...(simLockRequired !== undefined ? { simLockRequired } : {}),
		...(retries !== undefined ? { simLockRemainingAttempts: retries } : {}),
		...(esim !== undefined ? { esim } : {}),
	};
}

/**
 * Fold one observer refresh into wire views.
 *
 * Order follows the tree's own wire order (the same order the observer
 * reconciles in), so two folds of the same refresh are byte-identical.
 */
export function foldDbusModemViews(
	tree: DecodedManagedObjects,
): readonly DbusModemView[] {
	const views: DbusModemView[] = [];
	for (const modemPath of pathsWithInterface(tree, MODEM_IFACE)) {
		const view = foldOne(tree, modemPath);
		if (view !== undefined) {
			views.push(view);
		}
	}
	return views;
}
