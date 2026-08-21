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
 * The three operator actions that can move a blocked modem, and NOTHING else can.
 *
 * ACKNOWLEDGING IS NOT DISMISSING. A failed rollback means the modem's true state
 * is unknown, so an acknowledgement has to END with a state the device has proven
 * — by one of exactly two typed paths:
 *
 *   verified-rollback — re-read the device and CONFIRM it equals the journaled
 *     pre-state. A mismatch REFUSES and the device stays blocked; the rollback
 *     demonstrably did not land, and clearing it would be a claim the hardware
 *     contradicts.
 *   force-rebaseline — the operator explicitly accepts the CURRENT hardware. The
 *     helper captures it, validates it is coherent, and journals it as the new
 *     baseline BEFORE anything is archived or unblocked.
 *
 * Both paths write `acknowledged` durably FIRST and archive SECOND, so a crash
 * between those two writes is replayable: startup finds `acknowledged` and resumes
 * the archive plus the unblock, rather than losing an operator decision.
 *
 * DECOMMISSION is the absent-device escape hatch and is deliberately narrower than
 * it looks: it releases GLOBAL streaming (a destroyed modem must never permanently
 * strand the remaining links) while leaving that one physical identity refusing
 * mutations. It is not terminal — identity is port-based for serial-less devices,
 * so a replacement unit in the same port inherits the key and is caught as
 * `recommission-pending` until an operator REBASELINES it.
 */

import type {
	ModemMutationAckMode,
	ModemMutationAckOutput,
	ModemMutationEntry,
	ModemMutationState,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

import { refreshMutationBlocks } from "./mutation-blocks.ts";
import {
	commitMutationEntry,
	journalNow,
	nextEntry,
	readMutationEntry,
	removeMutationEntry,
} from "./mutation-journal.ts";
import { isLegalMutationTransition } from "./mutation-journal-state.ts";
import {
	captureModemState,
	isCoherentState,
	statesMatch,
} from "./mutation-rollback.ts";

function fail(error: ModemMutationAckOutput["error"]): ModemMutationAckOutput {
	return { success: false, ...(error === undefined ? {} : { error }) };
}

async function advance(
	entry: ModemMutationEntry,
	state: ModemMutationState,
	detail: string,
	patch: Partial<ModemMutationEntry> = {},
): Promise<ModemMutationEntry> {
	if (!isLegalMutationTransition(entry.state, state)) {
		throw new Error(`illegal journal transition ${entry.state} → ${state}`);
	}
	const next = { ...nextEntry(entry, state, journalNow(), detail), ...patch };
	await commitMutationEntry(next);
	return next;
}

/** Journal `acknowledged`, then archive, then unblock — in that order, always. */
async function archiveAcknowledged(
	entry: ModemMutationEntry,
	mode: ModemMutationAckMode,
	detail: string,
	baseline?: Readonly<Record<string, unknown>>,
): Promise<ModemMutationAckOutput> {
	try {
		await advance(entry, "acknowledged", detail, {
			acknowledgedMode: mode,
			...(baseline === undefined ? {} : { preState: { ...baseline } }),
		});
	} catch (err) {
		logger.error("modem mutation acknowledgement did not commit", {
			module: "modems",
			stableKey: entry.stableKey,
			err,
		});
		return fail("journal_write_failed");
	}
	await removeMutationEntry(entry.stableKey);
	await refreshMutationBlocks();
	return { success: true, state: "acknowledged" };
}

async function quarantine(
	entry: ModemMutationEntry,
): Promise<ModemMutationAckOutput> {
	if (isLegalMutationTransition(entry.state, "device-absent-quarantine")) {
		await advance(
			entry,
			"device-absent-quarantine",
			"device absent at acknowledgement",
		).catch(() => undefined);
		await refreshMutationBlocks();
	}
	return fail("device_absent");
}

export async function acknowledgeMutation(
	stableKey: string,
	mode: ModemMutationAckMode,
): Promise<ModemMutationAckOutput> {
	const entry = await readMutationEntry(stableKey);
	if (entry === undefined) return fail("no_entry");
	if (entry.state !== "failed") return fail("not_blocked");

	let current: Readonly<Record<string, unknown>> | undefined;
	try {
		current = await captureModemState(stableKey);
	} catch {
		return fail("read_failed");
	}
	if (current === undefined) return quarantine(entry);

	if (mode === "verified-rollback") {
		return statesMatch(entry.preState, current)
			? archiveAcknowledged(entry, mode, "rollback verified against the device")
			: fail("state_mismatch");
	}

	if (!isCoherentState(current)) return fail("read_failed");
	return archiveAcknowledged(
		entry,
		mode,
		"operator accepted the current hardware state as the new baseline",
		current,
	);
}

export async function decommissionMutation(
	stableKey: string,
): Promise<ModemMutationAckOutput> {
	const entry = await readMutationEntry(stableKey);
	if (entry === undefined) return fail("no_entry");
	if (entry.state !== "device-absent-quarantine") return fail("not_blocked");
	try {
		await advance(
			entry,
			"decommissioned",
			"operator confirmed the device is gone",
		);
	} catch (err) {
		logger.error("modem decommission did not commit", {
			module: "modems",
			stableKey,
			err,
		});
		return fail("journal_write_failed");
	}
	await refreshMutationBlocks();
	return { success: true, state: "decommissioned" };
}

export async function rebaselineMutation(
	stableKey: string,
): Promise<ModemMutationAckOutput> {
	const entry = await readMutationEntry(stableKey);
	if (entry === undefined) return fail("no_entry");
	if (entry.state !== "recommission-pending") return fail("not_blocked");

	let current: Readonly<Record<string, unknown>> | undefined;
	try {
		current = await captureModemState(stableKey);
	} catch {
		return fail("read_failed");
	}
	if (current === undefined) return fail("device_absent");
	if (!isCoherentState(current)) return fail("read_failed");

	return archiveAcknowledged(
		entry,
		"force-rebaseline",
		"operator rebaselined the device now occupying this identity",
		current,
	);
}
