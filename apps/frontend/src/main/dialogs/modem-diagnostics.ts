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
 * The directly-managed modem's diagnostics dump — pure, rune-free, and the ONLY
 * place a raw provider-native value reaches this dialog.
 *
 * The router dongle has had this split since `router-dongle-fields.ts` grew
 * `diagnosticFields`; the ModemManager side never did, so its raw tokens went
 * one of two ways. Some were RELOCATED into an invisible `data-raw` attribute —
 * the band token, which the operator row correctly renders as a label — where a
 * field engineer cannot read them at all. Others stayed on operator-facing rows
 * (`cell_id`, a serving-cell identifier with no operator meaning). Neither is
 * the OL-3 bargain, which is that a raw token is MOVED and stays readable, one
 * disclosure away, in the device's own spelling.
 *
 * ── THE LABELS ARE THE PROVIDER'S OWN FIELD NAMES, ON PURPOSE ───────────────
 *
 * A diagnostics row is compared against a vendor table or pasted into a bug
 * report, so the label an engineer needs is the WIRE field name rather than a
 * translated one. That also keeps this module locale-free: it emits already
 * resolved rows and asks `@ceraui/i18n` for nothing.
 *
 * ── THE RETURN IS A DISCLOSURE BOUNDARY, NOT A LIST ─────────────────────────
 *
 * The record deliberately COLLECTS the subscriber identifiers this modem
 * published — an omission would be a second, silent policy sitting next to the
 * real one, and the next field added here would not inherit it. Every row leaves
 * through `redactDiagnosticRows`, so the identifiers are retained as rows and
 * masked as values, exactly as modem-stack's `redactObservationDiagnostics`
 * treats an `ObservationDiagnostics.raw` record. The operator-facing ICCID row
 * and the revealable own-number field elsewhere in this dialog are separate,
 * separately-justified affordances and are untouched by this.
 */

import type { Modem } from "@ceraui/rpc/schemas";

import { redactDiagnosticRows } from "$lib/modem/diagnostics-redaction";

export interface ModemDiagnosticRow {
	readonly id: string;
	readonly label: string;
	readonly value: string;
}

/**
 * A field the device did not state produces NO ROW — never a dash, which reads
 * as a reading that was taken and came back empty.
 *
 * `label` defaults to `id` because the two are normally the same wire field
 * name. They come apart only where a row already ships a `data-testid` the e2e
 * suite contracts on: the id keeps that contract, the label keeps the truth.
 */
function stated(
	rows: ReadonlyArray<{
		id: string;
		label?: string;
		value: string | undefined;
	}>,
): ModemDiagnosticRow[] {
	return rows
		.filter(
			(row): row is { id: string; label?: string; value: string } =>
				row.value !== undefined && row.value.trim() !== "",
		)
		.map((row) => ({
			id: row.id,
			label: row.label ?? row.id,
			value: row.value,
		}));
}

function numeric(value: number | undefined): string | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? String(value)
		: undefined;
}

/**
 * Every raw token the MODEM ROW published, redacted at the boundary.
 *
 * The order is the order an engineer reads a modem: what it is, where it sits,
 * what the radio reported, then the identifiers.
 *
 * `usb_mode` is deliberately ABSENT. The dialog holds a strictly better answer —
 * `displayedUsbMode`, which follows an in-flight composition switch the wire row
 * cannot yet reflect — so it contributes that row itself rather than having this
 * module publish a value it would immediately have to correct.
 */
export function modemDiagnosticRows(modem: Modem): ModemDiagnosticRow[] {
	const cell = modem.cell_info;
	return redactDiagnosticRows(
		stated([
			{ id: "device_class", value: modem.device_class },
			{ id: "availability_reason", value: modem.availability_reason },
			// Where the status strip's second line GOES when the backend could not
			// fold the access technology into "2G" … "5G" and passed the token
			// through. Drop this row and that omission becomes a deletion.
			{ id: "status.network_type", value: modem.status?.network_type },
			{ id: "stable_key", value: modem.stable_key },
			{ id: "recommended_usb_mode", value: modem.recommended_usb_mode },
			{ id: "radio_power", value: modem.radio_power },
			{ id: "firmware_revision", value: modem.firmware_revision },
			{ id: "cell_info.tech", value: cell?.tech },
			{ id: "serving-band", label: "cell_info.band", value: cell?.band },
			{ id: "cell_info.cell_id", value: cell?.cell_id },
			{ id: "cell_info.rsrp", value: numeric(cell?.rsrp) },
			{ id: "cell_info.rsrq", value: numeric(cell?.rsrq) },
			{ id: "cell_info.snr", value: numeric(cell?.snr) },
			{ id: "cell_info.sinr", value: numeric(cell?.sinr) },
			{ id: "cell_info.provenance.source", value: cell?.provenance?.source },
			{
				id: "cell_info.provenance.observed_at",
				value: numeric(cell?.provenance?.observed_at),
			},
			{ id: "iccid", value: modem.iccid },
			{ id: "own_numbers", value: modem.own_numbers?.join(" ") },
		]),
	);
}
