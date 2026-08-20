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

import { logger } from "../../helpers/logger.ts";
import {
	type ConnectionUUID,
	type NetworkManagerConnectionModemConfig,
	nmConnDelete,
	nmConnGetFields,
	nmConnSetFields,
	nmConnsGet,
	nmcliParseSep,
} from "../network/network-manager.ts";

/**
 * One gsm profile as NetworkManager describes it RIGHT NOW.
 *
 * Read fresh on every reconciliation rather than from the `gsmConnections`
 * cache: this is the input to a DESTRUCTIVE decision, and the cache is a
 * snapshot taken for a different purpose at an unrelated moment.
 */
export type GsmProfileAudit = {
	readonly uuid: string;
	readonly deviceId: string;
	readonly simId: string;
	/** nmcli `GENERAL.STATE`: EMPTY for a profile NM is not holding. */
	readonly state: string;
	readonly autoconnect: string;
	/** Seconds since epoch of the last SUCCESSFUL activation; `0` means never. */
	readonly timestamp: string;
};

const GSM_AUDIT_FIELDS = [
	"gsm.device-id",
	"gsm.sim-id",
	"connection.autoconnect",
	"connection.timestamp",
] as const;

/** A fresh, cache-independent audit of every gsm profile on the device. */
export async function auditGsmProfiles(): Promise<Array<GsmProfileAudit>> {
	const rows = await nmConnsGet("uuid,type,state");
	if (rows === undefined) return [];

	const audits: Array<GsmProfileAudit> = [];
	for (const row of rows) {
		const [uuid, type, state] = nmcliParseSep(row) as [string, string, string];
		if (type !== "gsm" || !uuid) continue;

		const fields = await nmConnGetFields(uuid, GSM_AUDIT_FIELDS);
		if (fields === undefined) continue;

		audits.push({
			uuid,
			deviceId: fields[0] ?? "",
			simId: fields[1] ?? "",
			state: state ?? "",
			autoconnect: fields[2] ?? "",
			timestamp: fields[3] ?? "",
		});
	}
	return audits;
}

export type GsmDuplicateVerdict = "keep" | "retain" | "prune";

/**
 * May this duplicate be DELETED?
 *
 * Todo 50 deliberately stopped at demotion because "created by us" was inferred
 * from a shared device+SIM alone, which is not ownership evidence. This adds the
 * evidence rather than dropping the requirement, and every clause is a POSITIVE
 * observation — nothing here reasons from absence:
 *
 * - it is not the profile we selected to write to;
 * - NetworkManager is not holding it right now (an EMPTY `GENERAL.STATE`;
 *   `activated`/`activating` both mean hands off — measured on the board);
 * - `connection.autoconnect` is `no`, which on a same-(device, SIM) clone is
 *   CeraUI's OWN footprint: `demoteDuplicateGsmProfiles`/this reconciler are the
 *   only writers of it here, so an armed clone has never been through our hands
 *   and is retained;
 * - `connection.timestamp` is `0`, i.e. NetworkManager has NEVER successfully
 *   activated it. A profile an operator has actually used carries a real stamp.
 *
 * An unreadable timestamp parses to NaN and therefore RETAINS — a failed read is
 * a statement about the read, never about the profile. Convergence is two-pass
 * by construction: an armed clone is enforced + demoted on this pass and only
 * becomes prunable on a LATER audit that observes the demotion, so a profile is
 * never deleted on the strength of a flag we set moments earlier.
 */
export function classifyGsmDuplicate(
	audit: GsmProfileAudit,
	keepUuid: string,
): GsmDuplicateVerdict {
	if (audit.uuid === keepUuid) return "keep";
	if (audit.state.trim() !== "") return "retain";
	if (audit.autoconnect.trim() !== "no") return "retain";
	if (Number.parseInt(audit.timestamp, 10) !== 0) return "retain";
	return "prune";
}

export type GsmReconcileResult = {
	readonly duplicates: number;
	readonly enforced: number;
	readonly demoted: number;
	readonly pruned: number;
	readonly retained: number;
};

export type GsmReconcileDeps = {
	readonly audit: () => Promise<Array<GsmProfileAudit>>;
	readonly setFields: (
		uuid: ConnectionUUID,
		fields: Record<string, string>,
	) => Promise<boolean>;
	readonly remove: (uuid: ConnectionUUID) => Promise<boolean>;
};

export const defaultGsmReconcileDeps: GsmReconcileDeps = {
	audit: auditGsmProfiles,
	setFields: nmConnSetFields,
	remove: nmConnDelete,
};

/**
 * Make every gsm profile bound to this (device, SIM) agree with the operator.
 *
 * Todo 50 fixed WHICH profile a save writes to and disarmed the rest; this fixes
 * what happens when NetworkManager picks one of the rest anyway. Board-measured
 * on a Quectel RM530N-GL carrying FOURTEEN profiles for one SIM: eleven still
 * read `gsm.home-only: no` while the operator had roaming DISABLED, so any path
 * that activated one of them — an autoconnect-priority change, a boot-time
 * reconnect, a stray `nmcli connection up <uuid>` — would have registered
 * roaming with no error, no notification, and a UI still showing the value the
 * one written profile carried.
 *
 * Enforcement, not selection, is what makes that impossible, so it runs FIRST
 * and unconditionally:
 *
 * 1. ENFORCE — write the operator's own gsm fields to every duplicate. After
 *    this step the answer to "which profile does NM activate" cannot change any
 *    operator-visible behaviour, because they are all the same answer. This is
 *    the guarantee; the two steps below are hygiene.
 * 2. DEMOTE — disarm `connection.autoconnect` on the duplicates, so the selected
 *    profile stays the one NM reaches for (todo 50's fix, preserved verbatim).
 * 3. PRUNE — delete only the duplicates {@link classifyGsmDuplicate} can prove
 *    are abandoned. A prune that fails costs nothing: step 1 already holds.
 *
 * The order is load-bearing in both directions. Enforcing before demoting means
 * a profile NM activates DURING the reconciliation already carries the right
 * values; classifying from the PRE-demotion audit means step 2 cannot manufacture
 * the evidence step 3 depends on.
 */
export async function reconcileDuplicateGsmProfiles(
	deviceId: string,
	simId: string,
	keepUuid: string,
	fields: NetworkManagerConnectionModemConfig,
	deps: GsmReconcileDeps = defaultGsmReconcileDeps,
): Promise<GsmReconcileResult> {
	const empty: GsmReconcileResult = {
		duplicates: 0,
		enforced: 0,
		demoted: 0,
		pruned: 0,
		retained: 0,
	};
	if (!deviceId || !simId || !keepUuid) return empty;

	const audits = await deps.audit();
	const duplicates = audits.filter(
		(a) => a.deviceId === deviceId && a.simId === simId && a.uuid !== keepUuid,
	);
	if (duplicates.length === 0) return empty;

	// Snapshot the verdicts BEFORE anything is written, so the demotion below
	// cannot become the evidence that authorizes a deletion.
	const verdicts = new Map(
		duplicates.map((a) => [a.uuid, classifyGsmDuplicate(a, keepUuid)] as const),
	);

	let enforced = 0;
	let demoted = 0;
	let pruned = 0;

	for (const duplicate of duplicates) {
		if (await deps.setFields(duplicate.uuid, { ...fields })) enforced += 1;
	}

	for (const duplicate of duplicates) {
		if (duplicate.autoconnect.trim() === "no") continue;
		if (
			await deps.setFields(duplicate.uuid, { "connection.autoconnect": "no" })
		)
			demoted += 1;
	}

	for (const duplicate of duplicates) {
		if (verdicts.get(duplicate.uuid) !== "prune") continue;
		if (await deps.remove(duplicate.uuid)) pruned += 1;
	}

	const retained = duplicates.length - pruned;
	logger.warn(
		`reconciled ${duplicates.length} duplicate gsm profiles for ${keepUuid}: ` +
			`${enforced} enforced, ${demoted} disarmed, ${pruned} deleted, ${retained} retained`,
		{ module: "modems", deviceId },
	);
	return { duplicates: duplicates.length, enforced, demoted, pruned, retained };
}
