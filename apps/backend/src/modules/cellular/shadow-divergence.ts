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
 * The shadow-mode divergence classifier — PURE, no I/O, no timers.
 *
 * It answers one question: does the read-only D-Bus observer see the same modems,
 * in the same state, as the mmcli path that is actually driving the device? Three
 * disciplines make the answer trustworthy rather than merely loud.
 *
 * ── 1. THE COMPARABLE STATE IS AN ALLOWLIST, AND THAT IS THE PRIMARY REDACTION ──
 *
 * {@link ShadowModemState} carries six non-secret observables and an OPAQUE device
 * key. There is no ICCID, EID, IMSI, IMEI, PIN, PUK, APN, username or password
 * field for a secret to ride on, and the mappers below copy field by field rather
 * than spreading a source object — so a future field added upstream cannot leak in
 * by accident. `shadow-redaction.ts` is the belt on top of these braces.
 *
 * ── 2. ABSENCE IS NOT A MISMATCH ──
 *
 * A field is compared ONLY when BOTH sides reported it. This is not laziness: the
 * two sources genuinely observe different dimensions. The observer's
 * `CellularSnapshot` has no signal-quality and no operator-name field at all, so
 * treating "mmcli says −71 dBm, dbus says nothing" as a divergence would emit one
 * false record per modem per cycle and bury the real findings the 14-day gate is
 * looking for. One-sided PRESENCE is still reported — that is exactly what
 * `only-in-mmcli` / `only-in-dbus` are for.
 *
 * ── 3. VOCABULARIES ARE FOLDED TO THEIR COMMON DENOMINATOR ──
 *
 * mmcli reports an access-technology GENERATION (`2G`/`3G`/`3G+`/`4G`/`5G`, highest
 * wins); the observer reports a RAT SET (`gsm`/`umts`/`lte`/`5gnr`). Compared raw
 * they disagree on every 3G+ device for no reason anyone should act on. Both are
 * folded onto the coarse `2G|3G|4G|5G` ladder — the finest granularity BOTH sides
 * can actually express — so a reported mismatch means the two disagree about the
 * radio, not about spelling.
 *
 * A row whose side cannot produce a join key is DROPPED and counted as
 * `unjoinable`, never invented into an `only-in-*`. An unjoinable row is a gap in
 * our ability to compare, and reporting a gap as a finding is the same error as
 * reporting an absent field as a mismatch.
 */

import { logger } from "../../helpers/logger.ts";
import { redactShadowPayload } from "./shadow-redaction.ts";

/** Coarse access-technology ladder both sources can express. */
export type ShadowGeneration = "2G" | "3G" | "4G" | "5G";

/** Coarse signal buckets — a magnitude nobody can mistake for a raw measurement. */
export type ShadowSignalBucket =
	| "none"
	| "poor"
	| "fair"
	| "good"
	| "excellent";

/**
 * Normalized, NON-SECRET modem state used for shadow comparison.
 *
 * `deviceKey` is OPAQUE — the hash of a non-secret join key, never the join key
 * itself, so a persisted record cannot carry a device identifier even if a future
 * join key were derived from one.
 */
export interface ShadowModemState {
	readonly deviceKey: string;
	readonly present: boolean;
	readonly registration?: string;
	readonly signalBucket?: ShadowSignalBucket;
	readonly operatorName?: string;
	readonly simPresent?: boolean;
	readonly networkType?: ShadowGeneration;
}

/** The comparable dimensions — everything on the state except the join key. */
export const SHADOW_COMPARABLE_FIELDS = [
	"present",
	"registration",
	"signalBucket",
	"operatorName",
	"simPresent",
	"networkType",
] as const satisfies ReadonlyArray<
	Exclude<keyof ShadowModemState, "deviceKey">
>;

export type ShadowComparableField = (typeof SHADOW_COMPARABLE_FIELDS)[number];

export interface ShadowFieldDivergence {
	readonly field: ShadowComparableField;
	readonly mmcli: unknown;
	readonly dbus: unknown;
}

export type ShadowDivergenceKind =
	| "only-in-mmcli"
	| "only-in-dbus"
	| "field-mismatch";

export interface ShadowModemDivergence {
	readonly deviceKey: string;
	readonly kind: ShadowDivergenceKind;
	readonly fields?: readonly ShadowFieldDivergence[];
}

/** A mapped side: the states we could join, plus how many rows we could not. */
export interface ShadowStateSet {
	readonly states: readonly ShadowModemState[];
	readonly unjoinable: number;
}

/** The log message shadow divergences are emitted under. */
export const SHADOW_DIVERGENCE_MSG = "modem shadow divergence";

// ── opaque device key ────────────────────────────────────────────────────────

/** Prefix making an opaque key recognisable in a record without decoding it. */
export const OPAQUE_DEVICE_KEY_PREFIX = "d-";

import { modemControlFunction } from "../modem-control-compat.ts";

const packagedClassifyShadowDivergences = modemControlFunction<
	typeof classifyShadowDivergences | undefined
>("classifyShadowDivergences", undefined);

const OPAQUE_DEVICE_KEY_HEX_CHARS = 16;

/**
 * Hash a non-secret join key into the stable opaque id records are written under.
 *
 * Stable across reboots and across the whole 14-day window (it is a plain digest,
 * not salted per boot) — which is precisely what the gate needs to count distinct
 * devices — while carrying nothing an operator could read a serial out of.
 */
export function opaqueDeviceKey(joinKey: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(joinKey).digest("hex");
	return `${OPAQUE_DEVICE_KEY_PREFIX}${digest.slice(0, OPAQUE_DEVICE_KEY_HEX_CHARS)}`;
}

// ── classification ───────────────────────────────────────────────────────────

/**
 * Compare mmcli-reported against dbus-observed states. A modem keyed on only one
 * side is `only-in-*`; a shared modem whose MUTUALLY-REPORTED fields differ yields
 * one `field-mismatch` carrying the per-field pairs. Identical states → `[]`.
 */
export function classifyShadowDivergences(
	mmcli: readonly ShadowModemState[],
	dbus: readonly ShadowModemState[],
): ShadowModemDivergence[] {
	if (packagedClassifyShadowDivergences !== undefined) {
		return packagedClassifyShadowDivergences(mmcli, dbus);
	}
	const mmcliByKey = new Map(mmcli.map((s) => [s.deviceKey, s]));
	const dbusByKey = new Map(dbus.map((s) => [s.deviceKey, s]));
	const divergences: ShadowModemDivergence[] = [];

	for (const [deviceKey, mmcliState] of mmcliByKey) {
		const dbusState = dbusByKey.get(deviceKey);
		if (dbusState === undefined) {
			divergences.push({ deviceKey, kind: "only-in-mmcli" });
			continue;
		}
		const fields = diffComparableFields(mmcliState, dbusState);
		if (fields.length > 0) {
			divergences.push({ deviceKey, kind: "field-mismatch", fields });
		}
	}
	for (const deviceKey of dbusByKey.keys()) {
		if (!mmcliByKey.has(deviceKey)) {
			divergences.push({ deviceKey, kind: "only-in-dbus" });
		}
	}
	return divergences;
}

function diffComparableFields(
	mmcli: ShadowModemState,
	dbus: ShadowModemState,
): ShadowFieldDivergence[] {
	const fields: ShadowFieldDivergence[] = [];
	for (const field of SHADOW_COMPARABLE_FIELDS) {
		const left = mmcli[field];
		const right = dbus[field];
		// Absence is not a mismatch — see the header. Only a field BOTH sides
		// reported can disagree.
		if (left === undefined || right === undefined) {
			continue;
		}
		if (left !== right) {
			fields.push({ field, mmcli: left, dbus: right });
		}
	}
	return fields;
}

// ── logging ──────────────────────────────────────────────────────────────────

/**
 * Build the redacted log/record payload. Each field mismatch is reshaped to key
 * the diff BY the field name so the key-based redactors can act on it, and the
 * whole payload then crosses {@link redactShadowPayload}.
 */
export function redactShadowDivergences(
	divergences: readonly ShadowModemDivergence[],
): unknown {
	const shaped = divergences.map((divergence) => {
		if (divergence.kind === "field-mismatch" && divergence.fields) {
			const fields: Record<string, { mmcli: unknown; dbus: unknown }> = {};
			for (const field of divergence.fields) {
				fields[field.field] = { mmcli: field.mmcli, dbus: field.dbus };
			}
			return { deviceKey: divergence.deviceKey, kind: divergence.kind, fields };
		}
		return { deviceKey: divergence.deviceKey, kind: divergence.kind };
	});
	return redactShadowPayload({
		count: divergences.length,
		divergences: shaped,
	});
}

export interface ShadowDivergenceLogDeps {
	/** Sink for the redacted divergence record. Defaults to `logger.warn`. */
	readonly log?: (msg: string, meta: unknown) => void;
	readonly debug?: (msg: string, meta: unknown) => void;
	readonly seen?: Set<string>;
}

export function logShadowDivergences(
	divergences: readonly ShadowModemDivergence[],
	deps: ShadowDivergenceLogDeps = {},
): void {
	if (divergences.length === 0) {
		return;
	}
	const sink =
		deps.log ?? ((msg: string, meta: unknown) => logger.warn(msg, meta));
	const debug =
		deps.debug ?? ((msg: string, meta: unknown) => logger.debug(msg, meta));
	const meta = redactShadowDivergences(divergences);
	const fingerprint = JSON.stringify(meta);
	if (deps.seen?.has(fingerprint) === true) {
		debug(SHADOW_DIVERGENCE_MSG, meta);
		return;
	}
	deps.seen?.add(fingerprint);
	sink(SHADOW_DIVERGENCE_MSG, meta);
}

// ── vocabulary folding ───────────────────────────────────────────────────────

const GENERATION_BY_TOKEN: Readonly<Record<string, ShadowGeneration>> = {
	// mmcli generations (`mmConvertAccessTech`) — `3G+` folds onto `3G`, the
	// finest rung the observer's RAT set can express.
	"2g": "2G",
	"3g": "3G",
	"3g+": "3G",
	"4g": "4G",
	"5g": "5G",
	// observer RAT names (`RadioAccessTechnology`)
	gsm: "2G",
	umts: "3G",
	lte: "4G",
	"5gnr": "5G",
};

const GENERATION_ORDER: readonly ShadowGeneration[] = ["2G", "3G", "4G", "5G"];

/** Fold one vocabulary token onto the shared ladder. Unknown tokens yield nothing. */
export function foldGeneration(token: string): ShadowGeneration | undefined {
	return GENERATION_BY_TOKEN[token.trim().toLowerCase()];
}

/**
 * Fold a set of tokens onto the HIGHEST generation present — the same "5G NSA
 * reports lte + 5gnr, call it 5G" rule `mmConvertAccessTech` already applies, so
 * the two sides agree on a carrier-aggregated device instead of disagreeing.
 */
export function foldGenerations(
	tokens: Iterable<string>,
): ShadowGeneration | undefined {
	let best: ShadowGeneration | undefined;
	for (const token of tokens) {
		const folded = foldGeneration(token);
		if (folded === undefined) {
			continue;
		}
		if (
			best === undefined ||
			GENERATION_ORDER.indexOf(folded) > GENERATION_ORDER.indexOf(best)
		) {
			best = folded;
		}
	}
	return best;
}

/**
 * Bucket an mmcli 0-100 signal quality. Buckets, never the raw number: a shadow
 * record is durable evidence about AGREEMENT, and two sources sampling a moving
 * radio milliseconds apart will always differ by a point or two.
 */
export function foldSignalBucket(
	quality: number | undefined,
): ShadowSignalBucket | undefined {
	if (quality === undefined || !Number.isFinite(quality)) {
		return undefined;
	}
	if (quality <= 0) return "none";
	if (quality < 25) return "poor";
	if (quality < 50) return "fair";
	if (quality < 75) return "good";
	return "excellent";
}

// ── secret-dropping mappers ──────────────────────────────────────────────────

/**
 * Loose mmcli-side modem shape. It is deliberately structural rather than an
 * import of `modules/modems`' `Modem`: the mapper must tolerate — and DROP — every
 * extra field that type carries, including `config.apn` / `config.username` /
 * `config.password`.
 */
export interface MmcliModemLike {
	readonly ifname?: unknown;
	readonly sim_network?: unknown;
	readonly sim_lock?: unknown;
	readonly removed?: unknown;
	readonly network_type?: unknown;
	readonly status?: unknown;
	readonly [extra: string]: unknown;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Map one mmcli modem to the normalized state, copying ONLY the allowlist.
 *
 * Returns `undefined` when the row carries no `ifname` — the one join key both
 * sources can produce (the observer reports it as the modem's data interface).
 * Several mappings are deliberately CONSERVATIVE, answering `undefined` rather
 * than guessing:
 *
 * · `registration` is emitted only for a modem mmcli PROVES is roaming. CeraUI's
 *   modem record keeps `registration-state` only as the derived `roaming` boolean,
 *   so home/searching/idle are indistinguishable here and claiming one would
 *   manufacture a mismatch out of our own lossy storage.
 * · `simPresent` is `true` on positive evidence (a named SIM network, or a lock
 *   state that requires a card) and otherwise `undefined` — never `false`, because
 *   an unregistered card legitimately reports neither.
 */
export function mmcliModemToShadowState(
	raw: MmcliModemLike,
): ShadowModemState | undefined {
	const ifname = asString(raw.ifname);
	if (ifname === undefined) {
		return undefined;
	}
	const status = asRecord(raw.status);
	const networkType = asRecord(raw.network_type);

	const state: {
		-readonly [K in keyof ShadowModemState]?: ShadowModemState[K];
	} = {
		deviceKey: opaqueDeviceKey(ifname),
		present: raw.removed !== true,
	};

	if (status?.roaming === true) {
		state.registration = "roaming";
	}

	const signal = typeof status?.signal === "number" ? status.signal : undefined;
	const bucket = foldSignalBucket(signal);
	if (bucket !== undefined) {
		state.signalBucket = bucket;
	}

	const operatorName = asString(status?.network);
	if (operatorName !== undefined) {
		state.operatorName = operatorName;
	}

	if (asString(raw.sim_network) !== undefined || asRecord(raw.sim_lock)) {
		state.simPresent = true;
	}

	const activeGeneration = asString(networkType?.active);
	const folded =
		activeGeneration === undefined
			? undefined
			: foldGeneration(activeGeneration);
	if (folded !== undefined) {
		state.networkType = folded;
	}

	return state as ShadowModemState;
}

/**
 * Map an observer row (a package `CellularSnapshot`, read STRUCTURALLY) to the
 * normalized state. Structural reading is what keeps the mapper from ever naming
 * `identity.subscriptionId` — the ICCID/EID field the package's own doc comment
 * marks SENSITIVE — and keeps the strict package type assignable without a cast.
 *
 * Returns `undefined` when the snapshot names no data interface: that is the join
 * key, and inventing a substitute (`equipmentId` is the IMEI) would both fail to
 * join against mmcli AND put a device serial into the pipeline.
 */
export function observationRowToShadowState(
	row: unknown,
): ShadowModemState | undefined {
	const record = asRecord(row) ?? {};
	const dataInterface = asRecord(record.dataInterface);
	const ifname = asString(dataInterface?.name);
	if (ifname === undefined) {
		return undefined;
	}

	const state: {
		-readonly [K in keyof ShadowModemState]?: ShadowModemState[K];
	} = {
		deviceKey: opaqueDeviceKey(ifname),
		present: record.presence === "present",
	};

	const registration = asRecord(record.registration);
	const status = asString(registration?.status);
	// `unknown` is the observer's own "I could not tell" — not a state to compare.
	if (status !== undefined && status !== "unknown") {
		state.registration = status;
	}

	const rats = registration?.activeRats;
	if (rats !== undefined && isIterable(rats)) {
		const folded = foldGenerations(
			[...rats].filter((r): r is string => typeof r === "string"),
		);
		if (folded !== undefined) {
			state.networkType = folded;
		}
	}

	const simSlots = Array.isArray(record.simSlots) ? record.simSlots : undefined;
	// An EMPTY slot list is "this modem reported no slots", not "no SIM".
	if (simSlots !== undefined && simSlots.length > 0) {
		state.simPresent = simSlots.some(
			(slot) => asRecord(slot)?.occupied === true,
		);
	}

	return state as ShadowModemState;
}

function isIterable(value: unknown): value is Iterable<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
			"function"
	);
}

/** Map a whole side, counting the rows that could not be joined. */
export function collectShadowStates<T>(
	rows: Iterable<T>,
	map: (row: T) => ShadowModemState | undefined,
): ShadowStateSet {
	const states: ShadowModemState[] = [];
	let unjoinable = 0;
	for (const row of rows) {
		const state = map(row);
		if (state === undefined) {
			unjoinable += 1;
			continue;
		}
		states.push(state);
	}
	return { states, unjoinable };
}
