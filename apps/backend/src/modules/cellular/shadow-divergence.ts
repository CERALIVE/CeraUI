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
 * `modem_shadow` divergence classifier (Phase B).
 *
 * Compares what mmcli reports against what the read-only dbus observer reports for
 * the SAME modem hardware and logs the differences — REDACTED. Two layers keep
 * secrets out of the log ("no ICCID/PIN/secrets" — annex):
 *
 *   1. EXCLUSION — the normalized {@link ShadowModemState} carries only non-secret
 *      observables. The state mappers ({@link mmcliModemToShadowState},
 *      {@link observationRowToShadowState}) copy an allowlist of fields and drop
 *      ICCID/EID (subscription id), PIN/PUK, APN, and password by construction.
 *   2. REDACTION — the log payload is scrubbed through the shared
 *      {@link logRedact} helper before it reaches any transport, so a secret-shaped
 *      value or a sensitive-keyed field that ever slipped into a comparable field is
 *      still scrubbed. This reuses CeraUI's ONE redaction mechanism — never a
 *      parallel one.
 *
 * The classifier is pure; the log function's sink is injectable for tests.
 */

import { logger, logRedact } from "../../helpers/logger.ts";

/**
 * Normalized, NON-SECRET modem state used for shadow comparison. There is no
 * ICCID/EID/PIN/PUK/APN/password field here — secrets never enter the comparison.
 * `id` is a non-secret stable join key (ifname / logical slot / equipment id).
 */
export interface ShadowModemState {
	readonly id: string;
	readonly present: boolean;
	readonly registration?: string;
	readonly signalBucket?: string;
	readonly operatorName?: string;
	readonly simPresent?: boolean;
	readonly networkType?: string;
}

/** The comparable dimensions (everything on {@link ShadowModemState} except `id`). */
const COMPARABLE_FIELDS = [
	"present",
	"registration",
	"signalBucket",
	"operatorName",
	"simPresent",
	"networkType",
] as const satisfies ReadonlyArray<Exclude<keyof ShadowModemState, "id">>;

export interface ShadowFieldDivergence {
	readonly field: string;
	readonly mmcli: unknown;
	readonly dbus: unknown;
}

export type ShadowDivergenceKind =
	| "only-in-mmcli"
	| "only-in-dbus"
	| "field-mismatch";

export interface ShadowModemDivergence {
	readonly id: string;
	readonly kind: ShadowDivergenceKind;
	readonly fields?: readonly ShadowFieldDivergence[];
}

/** The log message shadow divergences are emitted under. */
export const SHADOW_DIVERGENCE_MSG = "modem shadow divergence";

/**
 * Compare mmcli-reported vs dbus-observed states. A modem present in only one side
 * is `only-in-*`; a shared modem with differing comparable fields yields a
 * `field-mismatch` with the per-field pairs. Identical states → `[]`.
 */
export function classifyShadowDivergences(
	mmcli: readonly ShadowModemState[],
	dbus: readonly ShadowModemState[],
): ShadowModemDivergence[] {
	const mmcliById = new Map(mmcli.map((s) => [s.id, s]));
	const dbusById = new Map(dbus.map((s) => [s.id, s]));
	const divergences: ShadowModemDivergence[] = [];

	for (const [id, mmcliState] of mmcliById) {
		const dbusState = dbusById.get(id);
		if (dbusState === undefined) {
			divergences.push({ id, kind: "only-in-mmcli" });
			continue;
		}
		const fields = diffFields(mmcliState, dbusState);
		if (fields.length > 0) {
			divergences.push({ id, kind: "field-mismatch", fields });
		}
	}
	for (const [id] of dbusById) {
		if (!mmcliById.has(id)) {
			divergences.push({ id, kind: "only-in-dbus" });
		}
	}
	return divergences;
}

function diffFields(
	mmcli: ShadowModemState,
	dbus: ShadowModemState,
): ShadowFieldDivergence[] {
	const fields: ShadowFieldDivergence[] = [];
	for (const field of COMPARABLE_FIELDS) {
		if (mmcli[field] !== dbus[field]) {
			fields.push({ field, mmcli: mmcli[field], dbus: dbus[field] });
		}
	}
	return fields;
}

/**
 * Build the redacted log payload. Each field-mismatch is reshaped to key the diff BY
 * the field name, so {@link logRedact}'s sensitive-key rule scrubs a `simPin`-style
 * field wholesale, while its value-shape rule scrubs any token/PASETO/bearer value.
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
			return { id: divergence.id, kind: divergence.kind, fields };
		}
		return { id: divergence.id, kind: divergence.kind };
	});
	return logRedact({ count: divergences.length, divergences: shaped });
}

export interface ShadowDivergenceLogDeps {
	/** Sink for the redacted divergence record. Defaults to `logger.warn`. */
	readonly log?: ((msg: string, meta: unknown) => void) | undefined;
}

/** Log the redacted divergences. A no-op when there are none. */
export function logShadowDivergences(
	divergences: readonly ShadowModemDivergence[],
	deps: ShadowDivergenceLogDeps = {},
): void {
	if (divergences.length === 0) {
		return;
	}
	const sink = deps.log ?? ((msg, meta) => logger.warn(msg, meta));
	sink(SHADOW_DIVERGENCE_MSG, redactShadowDivergences(divergences));
}

// ── secret-dropping state mappers ────────────────────────────────────────────

/** Loose mmcli-side modem shape — extra (secret) fields are tolerated and DROPPED. */
export interface MmcliModemLike {
	readonly id: string;
	readonly present?: boolean | undefined;
	readonly registration?: string | undefined;
	readonly signalBucket?: string | undefined;
	readonly operatorName?: string | undefined;
	readonly simPresent?: boolean | undefined;
	readonly networkType?: string | undefined;
	readonly [extra: string]: unknown;
}

/**
 * Map an mmcli modem to the normalized state, copying ONLY the non-secret allowlist.
 * ICCID/PIN/APN/password (or any other extra field) are dropped by construction.
 */
export function mmcliModemToShadowState(raw: MmcliModemLike): ShadowModemState {
	const state: {
		-readonly [K in keyof ShadowModemState]?: ShadowModemState[K];
	} = {
		id: raw.id,
		present: raw.present ?? false,
	};
	if (raw.registration !== undefined) state.registration = raw.registration;
	if (raw.signalBucket !== undefined) state.signalBucket = raw.signalBucket;
	if (raw.operatorName !== undefined) state.operatorName = raw.operatorName;
	if (raw.simPresent !== undefined) state.simPresent = raw.simPresent;
	if (raw.networkType !== undefined) state.networkType = raw.networkType;
	return state as ShadowModemState;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Map an observer row (a package `CellularSnapshot`, read structurally) to the
 * normalized state. The join key is the non-secret logical-slot / equipment id —
 * NEVER the subscription id (ICCID/EID). Read via safe narrowing so the strict
 * package type assigns without a cast and no secret field is ever reached.
 */
export function observationRowToShadowState(row: unknown): ShadowModemState {
	const record = asRecord(row) ?? {};
	const identity = asRecord(record.identity);
	const equipmentId = asRecord(identity?.equipmentId);
	const id =
		asString(identity?.logicalSlotId) ??
		asString(equipmentId?.value) ??
		asString(identity?.runtimePath) ??
		"unknown";

	const registration = asRecord(record.registration);
	const simSlots = Array.isArray(record.simSlots) ? record.simSlots : undefined;

	const state: {
		-readonly [K in keyof ShadowModemState]?: ShadowModemState[K];
	} = {
		id,
		present: record.presence === "present",
	};
	const registrationStatus = asString(registration?.status);
	if (registrationStatus !== undefined) {
		state.registration = registrationStatus;
	}
	if (simSlots !== undefined) {
		state.simPresent = simSlots.some(
			(slot) => asRecord(slot)?.occupied === true,
		);
	}
	return state as ShadowModemState;
}
