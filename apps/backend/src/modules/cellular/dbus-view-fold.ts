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
	MODEM_LOCATION_IFACE,
	MODEM3GPP_IFACE,
	numberProp,
	pathsWithInterface,
	propValue,
	SIM_IFACE,
	stringProp,
} from "@ceralive/modem-control";
import type { DbusValue } from "@ceralive/modem-control/transport";
import type {
	ModemFlagMetric,
	ModemMetricUnknownReason,
	ModemNumberMetric,
	ModemRegistrationContext,
	ModemSignalDetail,
	ModemTextMetric,
} from "@ceraui/rpc/schemas";
import { canonicalModemIdPath } from "@ceraui/rpc/schemas";

import type {
	DbusModemView,
	DbusRegistrationView,
} from "../modems/modem-wire-adapters.ts";
import {
	readSimPresenceEvidence,
	SIM_MISSING_FAILED_REASON,
} from "../modems/sim-presence.ts";

import {
	decodeAccessTechnologies,
	decodeEsimStatus,
	decodeLacCi,
	decodeMmState,
	decodeNetworkRejectionError,
	decodePacketServiceState,
	decodeRadioPower,
	decodeRegistrationState,
	decodeSimType,
	decodeUnlockRequired,
	LOCATION_SOURCE_3GPP_LAC_CI,
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
 *
 * It returns the presence WITH THE FACT THAT DECIDED IT, because `absent` and
 * "we could not tell" are read off the same empty fields and only the evidence
 * separates them. The numeric `StateFailedReason` is folded to MM's own
 * `sim-missing` token here so the two backends hand the shared reader identical
 * facts rather than one numeric and one textual dialect of the same answer.
 */
function readSimPresence(
	modem: ReturnType<typeof findInterface>,
): ReturnType<typeof readSimPresenceEvidence> {
	const sim = stringProp(modem, "Sim");
	const slots = propValue(modem, "SimSlots");
	const failed = numberProp(modem, "StateFailedReason");
	return readSimPresenceEvidence({
		...(sim === undefined ? {} : { sim }),
		...(Array.isArray(slots)
			? {
					simSlots: slots.filter(
						(slot): slot is string => typeof slot === "string",
					),
				}
			: {}),
		...(failed === FAILED_REASON_SIM_MISSING
			? { failedReason: SIM_MISSING_FAILED_REASON }
			: {}),
	});
}

/**
 * One entry of an `a{sv}` property, unwrapped past its variant.
 *
 * The codec decodes a dict to `[key, {signature, value}]` pairs and `propValue`
 * only unwraps the OUTER property variant, so a nested `a{sv}` still carries a
 * variant per value — which is why this cannot reuse `stringProp`/`numberProp`.
 */
function dictEntry(dict: DbusValue | undefined, key: string | number): unknown {
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
 * Whether the dict CONTAINS `key`, regardless of what the value decodes to.
 *
 * Separate from {@link dictEntry} because the two answer different questions and
 * the readers below need both: a member that is present but undecodable is
 * `malformed` (stop, report it), while a member that is absent means try the
 * next RAT rung. Reading a `undefined` return from `dictEntry` as absence would
 * silently demote the first case into the second and hide a real decode fault.
 *
 * The key is widened exactly as {@link dictEntry}'s is, because the same
 * question is asked of `Modem.Signal`'s string-keyed `a{sv}` and of
 * `Modem.Location`'s NUMBER-keyed `a{uv}`.
 */
function hasDictKey(
	dict: DbusValue | undefined,
	key: string | number,
): boolean {
	if (!Array.isArray(dict)) return false;
	return dict.some((entry) => Array.isArray(entry) && entry[0] === key);
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

const MODEM_SIGNAL_IFACE = "org.freedesktop.ModemManager1.Modem.Signal";

/**
 * Per-metric RAT ladders over `Modem.Signal`'s `a{sv}` properties.
 *
 * NEWEST RAT FIRST, and nothing is merged or averaged: on an NSA attach both
 * `Nr5g` and `Lte` are populated with DIFFERENT measurements of different
 * carriers, so a ladder picks one reading rather than inventing a third.
 *
 * `sinr` reads `Evdo` ALONE, and that is ModemManager's own shape rather than a
 * conservative choice: its 1.24.2 introspection gives `sinr` to `Evdo` and to no
 * other dict, while `Lte`/`Nr5g` publish `snr`, a different quantity. Claiming
 * SINR off an LTE dict would be exactly the invented reading this layer exists
 * to prevent, so an LTE/NR modem answers `not-reported`.
 */
const EXTENDED_SIGNAL_LADDER = ["Nr5g", "Lte"] as const;
const SINR_LADDER = ["Evdo"] as const;

function knownNumber(value: number): ModemNumberMetric {
	return { state: "known", value };
}

function unknownNumber(reason: ModemMetricUnknownReason): ModemNumberMetric {
	return { state: "unknown", reason };
}

function unknownText(reason: ModemMetricUnknownReason): ModemTextMetric {
	return { state: "unknown", reason };
}

/**
 * One extended-signal member, walked down its RAT ladder.
 *
 * Four outcomes, and each names a different thing: the member decoded
 * (`known`); every rung was inspected and none carried it (`not-reported` — the
 * read class, which is what an unprimed `Modem.Signal` and a RAT-inapplicable
 * metric both look like); the member was there and was not a number
 * (`malformed`).
 */
function readLadderMetric(
	signal: ReturnType<typeof findInterface>,
	ladder: readonly string[],
	member: string,
): ModemNumberMetric {
	for (const property of ladder) {
		const dict = propValue(signal, property);
		if (!hasDictKey(dict, member)) continue;
		const raw = dictEntry(dict, member);
		return typeof raw === "number" && Number.isFinite(raw)
			? knownNumber(raw)
			: unknownNumber("malformed");
	}
	return unknownNumber("not-reported");
}

/**
 * `Modem.SignalQuality` is a `(ub)`: the 0-100 percentage the wire already
 * carries as `status.signal`, AND a boolean saying whether the modem measured
 * it recently or is serving its last cached reading. Only the percentage was
 * ever projected, so an operator could not tell a live 40% from a stale one.
 */
function readQualityRecent(
	modem: ReturnType<typeof findInterface>,
): ModemFlagMetric {
	const quality = propValue(modem, "SignalQuality");
	if (quality === undefined) {
		return { state: "unknown", reason: "not-reported" };
	}
	if (!Array.isArray(quality) || typeof quality[1] !== "boolean") {
		return { state: "unknown", reason: "malformed" };
	}
	return { state: "known", value: quality[1] };
}

function readSignalDetail(
	tree: DecodedManagedObjects,
	modemPath: string,
	modem: ReturnType<typeof findInterface>,
): ModemSignalDetail {
	const quality_recent = readQualityRecent(modem);
	const signal = findInterface(tree, modemPath, MODEM_SIGNAL_IFACE);
	if (signal === undefined) {
		return {
			quality_recent,
			rsrp: unknownNumber("not-observed"),
			rsrq: unknownNumber("not-observed"),
			snr: unknownNumber("not-observed"),
			sinr: unknownNumber("not-observed"),
		};
	}
	return {
		quality_recent,
		rsrp: readLadderMetric(signal, EXTENDED_SIGNAL_LADDER, "rsrp"),
		rsrq: readLadderMetric(signal, EXTENDED_SIGNAL_LADDER, "rsrq"),
		snr: readLadderMetric(signal, EXTENDED_SIGNAL_LADDER, "snr"),
		sinr: readLadderMetric(signal, SINR_LADDER, "sinr"),
	};
}

/**
 * A string property as a metric, so an empty answer keeps its reason.
 *
 * An absent INTERFACE is `not-observed` (nobody read it); an absent PROPERTY on
 * a present interface is `not-reported` (it answered and omitted the field); a
 * non-string is `malformed`. ModemManager publishes `""` for an unregistered
 * modem's operator, which is absence rather than an empty name, so it folds
 * onto `not-reported` too.
 */
function readTextMetric(
	iface: ReturnType<typeof findInterface>,
	property: string,
): ModemTextMetric {
	if (iface === undefined) {
		return unknownText("not-observed");
	}
	const raw = propValue(iface, property);
	if (raw === undefined) {
		return unknownText("not-reported");
	}
	if (typeof raw !== "string") {
		return unknownText("malformed");
	}
	const trimmed = raw.trim();
	return trimmed.length > 0
		? { state: "known", value: trimmed }
		: unknownText("not-reported");
}

/**
 * Coarse cell context from `Modem.Location`'s `3gpp-lac-ci` entry.
 *
 * NOTHING ON THIS PATH ENABLES A LOCATION SOURCE, and that is why the honest
 * steady state is `not-observed` rather than a value. ModemManager MASKS the
 * `Location` property unless `Location.Setup` ran with `signal_location = true`,
 * which is permanently forbidden here, and the audited transport's allowlist
 * admits no `Location` call at all — so on a board where nothing else enabled
 * the source the property is simply absent and both metrics say so. When some
 * other agent HAS enabled it, the value is already being published and reading
 * it is a normalization step rather than a new capability.
 *
 * `cellId` and `tac` come out of ONE decoded value, so they can never describe
 * two different cells. An undecodable value makes BOTH `malformed`; an empty
 * TAC alone reads `not-reported`, because a 2G/3G attach genuinely has none.
 */
function readCellContext(
	tree: DecodedManagedObjects,
	modemPath: string,
): { readonly cell_id: ModemTextMetric; readonly tac: ModemTextMetric } {
	const location = findInterface(tree, modemPath, MODEM_LOCATION_IFACE);
	if (location === undefined) {
		return {
			cell_id: unknownText("not-observed"),
			tac: unknownText("not-observed"),
		};
	}
	const dict = propValue(location, "Location");
	if (!hasDictKey(dict, LOCATION_SOURCE_3GPP_LAC_CI)) {
		return {
			cell_id: unknownText("not-reported"),
			tac: unknownText("not-reported"),
		};
	}
	const raw = dictEntry(dict, LOCATION_SOURCE_3GPP_LAC_CI);
	const decoded = typeof raw === "string" ? decodeLacCi(raw) : undefined;
	if (decoded === undefined) {
		return {
			cell_id: unknownText("malformed"),
			tac: unknownText("malformed"),
		};
	}
	return {
		cell_id:
			decoded.cellId.length > 0
				? { state: "known", value: decoded.cellId }
				: unknownText("not-reported"),
		tac:
			decoded.trackingAreaCode.length > 0
				? { state: "known", value: decoded.trackingAreaCode }
				: unknownText("not-reported"),
	};
}

function readRegistrationContext(
	tree: DecodedManagedObjects,
	modemPath: string,
	modem3gpp: ReturnType<typeof findInterface>,
): ModemRegistrationContext {
	return {
		operator_name: readTextMetric(modem3gpp, "OperatorName"),
		operator_code: readTextMetric(modem3gpp, "OperatorCode"),
		...readCellContext(tree, modemPath),
	};
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
	const radioPower = decodeRadioPower(numberProp(modem, "PowerState"));
	const signalDetail = readSignalDetail(tree, modemPath, modem);
	const registrationContext = readRegistrationContext(
		tree,
		modemPath,
		modem3gpp,
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
		...(simPresence.presence !== "unknown"
			? { simPresence: simPresence.presence }
			: {}),
		// The evidence rides EVERY row, including an `unknown` one — that is the
		// case it exists for, because `no-evidence` naming the inspected fields is
		// what separates "we looked and the modem said nothing" from "we did not
		// look". A present-only-when-decisive field could never lower its claim.
		simPresenceEvidence: simPresence.evidence,
		signalDetail,
		registrationContext,
		...(ownNumbers !== undefined ? { ownNumbers } : {}),
		...(iccid !== undefined ? { iccid } : {}),
		...(registrationRejection !== undefined ? { registrationRejection } : {}),
		...(packetServiceState !== undefined ? { packetServiceState } : {}),
		...(radioPower !== undefined ? { radioPower } : {}),
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
