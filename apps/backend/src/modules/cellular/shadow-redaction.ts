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
 * Redaction for everything shadow mode LOGS or PERSISTS.
 *
 * Shadow evidence is written to disk and kept for at least the 14-day retirement
 * window, so a leak here is durable rather than transient. Three layers stack, and
 * each one is load-bearing because the one above it can be defeated by a mistake
 * the one below still catches:
 *
 *   1. EXCLUSION (the primary defence, in `shadow-divergence.ts`) — the normalized
 *      comparable state is a six-field ALLOWLIST copied field by field. ICCID, EID,
 *      IMSI, IMEI, PIN/PUK and the APN username/password have no field to ride on.
 *   2. KEY REDACTION (here) — a recursive walk that blanks the value under any
 *      sensitive key. It is the union of THREE key sets, because no single existing
 *      one covers the classes this effort cares about:
 *        · `@ceralive/modem-control`'s {@link redactModemFields} — `iccid`, `imsi`,
 *          `eid`, `pin*`, `puk*`, `password`, `passwd`, `subscriptionid`;
 *        · {@link SHADOW_EXTRA_SENSITIVE_KEYS} — the CeraUI-side gap: `apn`,
 *          `username`, `msisdn`, `imei`, `equipmentid`, `serial`, and friends, none
 *          of which either existing redactor knows about;
 *        · CeraUI's own {@link logRedact} — the `pin|password|token|secret|paseto|
 *          bcrp|auth` regex PLUS the value-SHAPE rules (PASETO / JWT / Bearer),
 *          which are the only rules that fire on a secret under an innocent key.
 *   3. The suite in `tests/cellular-shadow-redaction.test.ts`, which string-searches
 *      the SERIALIZED output for real-shaped fixtures rather than trusting any of
 *      the above.
 *
 * The key sets are composed, never copied: `redactModemFields` is imported from the
 * package so its set cannot drift out from under us, and a skew test pins that our
 * union really is a superset of it.
 *
 * The package root is import-safe here — every `../transport` edge inside it is an
 * `import type`, so pulling `redact` does NOT load `@httptoolkit/dbus-native`. That
 * keeps this module usable from the pure classifier without dragging the D-Bus
 * client onto a default device's load path.
 */

import { redact as redactModemFields } from "@ceralive/modem-control";

import { logRedact } from "../../helpers/logger.ts";

/**
 * Sensitive keys NEITHER existing redactor covers. Matched case-insensitively and
 * EXACTLY (or exactly on the last dotted segment), mirroring the package's rule —
 * so `gsm.username` is blanked while a hypothetical `username-flags` is not.
 *
 * `apn` is here because an APN string is itself carrier-account-identifying, and
 * `username`/`user` because the APN credential pair is only half-covered by
 * `password`. `imei`/`equipmentid`/`serial`/`deviceid` are device serials: the
 * retention contract requires opaque ids, so a raw one must never survive into a
 * persisted record even if some future field carries it.
 */
export const SHADOW_EXTRA_SENSITIVE_KEYS: ReadonlySet<string> = new Set<string>(
	[
		"apn",
		"username",
		"user",
		"msisdn",
		"phonenumber",
		"imei",
		"imeisv",
		"meid",
		"esn",
		"equipmentid",
		"deviceid",
		"deviceidentifier",
		"serial",
		"serialnumber",
		"simid",
		"subscriberid",
	],
);

function isExtraSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase();
	if (SHADOW_EXTRA_SENSITIVE_KEYS.has(lower)) {
		return true;
	}
	const dot = lower.lastIndexOf(".");
	return dot >= 0 && SHADOW_EXTRA_SENSITIVE_KEYS.has(lower.slice(dot + 1));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function redactExtraKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redactExtraKeys);
	}
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			out[key] = isExtraSensitiveKey(key)
				? SHADOW_REDACTED
				: redactExtraKeys(inner);
		}
		return out;
	}
	return value;
}

/** The marker this module substitutes for a value it blanks itself. */
export const SHADOW_REDACTED = "[REDACTED]";

/**
 * Return a redacted deep copy of `value`, safe to log OR persist. The input is
 * never mutated. Composition order is deliberate: the two exact-key passes run
 * first so a sensitive value is gone before {@link logRedact}'s value-shape rules
 * even look at it, and `logRedact` runs LAST so it is the final word on anything
 * shaped like a credential under a key nobody anticipated.
 */
export function redactShadowPayload(value: unknown): unknown {
	return logRedact(redactExtraKeys(redactModemFields(value)));
}
