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
 * THE DISCLOSURE BOUNDARY every diagnostics table crosses.
 *
 * A diagnostics block is a DUMP: it exists so a field engineer reads the
 * device's own spelling of everything it published, which is precisely why it
 * accumulates the values nobody would put on an operator-facing row. Retention
 * and DISCLOSURE are different decisions, and modem-stack's observation layer
 * already draws exactly this line — `ObservationDiagnostics.raw` keeps a vendor
 * payload verbatim, and `redactObservationDiagnostics` is the boundary anything
 * that logs, serializes or files it MUST route through
 * (`control/src/observations/provenance.ts`).
 *
 * This is that boundary for the render side, and it was missing: the router
 * dongle's diagnostics table shipped `imsi` and `iccid`, and its unit table
 * shipped `imei`, straight from the wire to the screen — on a surface routinely
 * open while an operator screen-shares a stream.
 *
 * ── IT IS A RULE-D MIRROR, NOT A SHARED IMPORT ──────────────────────────────
 *
 * `@ceralive/modem-control` is a BACKEND dependency; the browser bundle has no
 * business carrying a D-Bus control library to reach one key set. The classes
 * below are re-derived from that package's `redact.ts` — the same relationship
 * the support-claim ladder and the SMS/own-number key sets already have with
 * their CeraUI twins, kept honest by tests rather than by a path.
 *
 * ── THE VALUE IS MASKED; THE ROW SURVIVES ───────────────────────────────────
 *
 * Dropping the row would make a redacted identifier indistinguishable from a
 * field the device never stated, which is the one claim a diagnostics table may
 * never make. `redact` keeps the key and substitutes the marker, so the row says
 * "this device published an ICCID and we are not showing it" — a decision, not a
 * failed read.
 */

/** The marker substituted for every redacted value, mirroring `REDACTED`. */
export const DIAGNOSTIC_REDACTED = "[redacted]";

/**
 * Leaf key names whose VALUE identifies a subscriber, their card, or their
 * credentials.
 *
 * Separators are folded uniformly here where the package lists `imei` /
 * `equipment-identifier` / `equipment_identifier` as three literals. That is a
 * deliberate WIDENING, never a narrowing: folding can only ever match more keys,
 * and this side reads field ids chosen by three different vendor dialects rather
 * than one daemon's property names.
 */
const SUBSCRIBER_IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
	"iccid",
	"imsi",
	"imei",
	"eid",
	"equipmentidentifier",
	"msisdn",
	"ownnumber",
	"ownnumbers",
	"subscriptionid",
	"pin",
	"pin2",
	"newpin",
	"puk",
	"puk2",
	"password",
	"passwd",
]);

function fold(key: string): string {
	const lowered = key.toLowerCase().replace(/[_\-\s]/g, "");
	const lastSegment = lowered.slice(lowered.lastIndexOf(".") + 1);
	return lastSegment;
}

/** Whole-key subscriber-identifier test, case-, separator- and dot-insensitive. */
export function isSubscriberIdentifierKey(key: string): boolean {
	return SUBSCRIBER_IDENTIFIER_KEYS.has(fold(key));
}

/** The minimum shape this boundary needs. Any diagnostics row satisfies it. */
interface RedactableRow {
	readonly id: string;
	readonly value: string;
}

/**
 * A copy of `rows` with every subscriber-identifier VALUE replaced by the
 * marker. The input is never mutated, and a row carrying no identifier is
 * returned by reference so an unaffected table stays byte-identical.
 */
export function redactDiagnosticRows<Row extends RedactableRow>(
	rows: readonly Row[],
): Row[] {
	return rows.map((row) =>
		isSubscriberIdentifierKey(row.id)
			? { ...row, value: DIAGNOSTIC_REDACTED }
			: row,
	);
}
