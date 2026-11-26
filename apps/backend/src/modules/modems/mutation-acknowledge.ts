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
import { verifyRouterSubnet } from "../network/router-subnet-verify.ts";

import { refreshMutationBlocks } from "./mutation-blocks.ts";
import {
	commitMutationEntry,
	journalNow,
	nextEntry,
	readMutationEntry,
	removeMutationEntry,
} from "./mutation-journal.ts";
import {
	isMutationJournalRevisionCurrent,
	mutationJournalRevision,
} from "./mutation-journal-revision.ts";
import { isLegalMutationTransition } from "./mutation-journal-state.ts";
import { withRetirementKey } from "./mutation-retirement-key.ts";
import { statesMatch } from "./mutation-rollback.ts";
import { resolveMutationDevice } from "./router-subnet-recovery-device.ts";

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
		if (entry.state !== "acknowledged") {
			await advance(entry, "acknowledged", detail, {
				acknowledgedMode: mode,
				...(baseline === undefined ? {} : { preState: { ...baseline } }),
			});
		}
		await removeMutationEntry(entry.stableKey);
	} catch (err) {
		logger.error("modem mutation acknowledgement did not commit", {
			module: "modems",
			stableKey: entry.stableKey,
			err,
		});
		return fail("journal_write_failed");
	}
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

export function acknowledgeMutation(
	stableKey: string,
	mode: ModemMutationAckMode,
	signal?: AbortSignal,
): Promise<ModemMutationAckOutput> {
	return withRetirementKey(
		stableKey,
		(entry) =>
			entry.state === "acknowledged" ||
			entry.state === "failed" ||
			(mode === "force-rebaseline" &&
				entry.state === "device-absent-quarantine"),
		signal,
		() => acknowledgeHeld(stableKey, mode),
	);
}

async function acknowledgeHeld(
	stableKey: string,
	mode: ModemMutationAckMode,
): Promise<ModemMutationAckOutput> {
	const revision = mutationJournalRevision();
	const entry = await readMutationEntry(stableKey);
	if (entry === undefined) return fail("no_entry");
	if (entry.stableKey !== stableKey) return fail("state_mismatch");
	if (entry.state === "acknowledged") {
		if (!isMutationJournalRevisionCurrent(revision)) return fail("not_blocked");
		return archiveAcknowledged(entry, mode, "resume acknowledged retirement");
	}
	if (
		entry.state !== "failed" &&
		!(mode === "force-rebaseline" && entry.state === "device-absent-quarantine")
	)
		return fail("not_blocked");

	const device = await resolveMutationDevice(entry);
	if (!isMutationJournalRevisionCurrent(revision)) return fail("not_blocked");
	if (device.status === "absent") return quarantine(entry);
	if (device.status !== "present") return fail("read_failed");

	if (mode === "verified-rollback") {
		if (entry.kind === "router-subnet") {
			const result = await verifyRouterSubnet(entry.preState, device.ifname);
			if (!isMutationJournalRevisionCurrent(revision))
				return fail("not_blocked");
			if ("error" in result) return fail(result.error);
			if (!result.isCurrent()) return fail("read_failed");
			return archiveAcknowledged(
				entry,
				mode,
				"original router DHCP record verified",
			);
		}
		return device.identity === "usb-descriptor" &&
			statesMatch(entry.preState, device.state)
			? archiveAcknowledged(entry, mode, "rollback verified against the device")
			: fail("state_mismatch");
	}

	if (entry.state === "device-absent-quarantine") {
		try {
			await advance(entry, "failed", "device returned before acknowledgement");
		} catch {
			return fail("journal_write_failed");
		}
		// Resample after the durable transition, under the same lease.
		const result = await acknowledgeHeld(stableKey, mode);
		if (!result.success) await refreshMutationBlocks();
		return result;
	}
	return archiveAcknowledged(
		entry,
		mode,
		"operator accepted the current hardware state as the new baseline",
		device.state,
	);
}

export function decommissionMutation(
	stableKey: string,
	signal?: AbortSignal,
): Promise<ModemMutationAckOutput> {
	return withRetirementKey(stableKey, canDecommission, signal, () =>
		decommissionHeld(stableKey),
	);
}

function canDecommission(entry: ModemMutationEntry): boolean {
	return entry.state === "device-absent-quarantine" || entry.state === "failed";
}

async function decommissionHeld(
	stableKey: string,
): Promise<ModemMutationAckOutput> {
	const revision = mutationJournalRevision();
	const entry = await readMutationEntry(stableKey);
	if (entry === undefined) return fail("no_entry");
	if (entry.stableKey !== stableKey) return fail("state_mismatch");
	if (!canDecommission(entry)) return fail("not_blocked");
	if (!isMutationJournalRevisionCurrent(revision)) return fail("not_blocked");
	const presence = await resolveMutationDevice(entry);
	if (!isMutationJournalRevisionCurrent(revision)) return fail("not_blocked");
	if (presence.status === "unknown") return fail("read_failed");
	if (presence.status === "present") {
		if (entry.state === "failed") return fail("state_mismatch");
		try {
			await advance(entry, "failed", "device returned before decommission");
		} catch {
			return fail("journal_write_failed");
		}
		await refreshMutationBlocks();
		return fail("state_mismatch");
	}
	try {
		if (entry.state === "failed") {
			await advance(
				entry,
				"device-absent-quarantine",
				"device absent at decommission",
			);
			// Re-observe after the awaited durable transition, still under
			// the same lease. A replacement may have arrived meanwhile.
			const result = await decommissionHeld(stableKey);
			if (!result.success) await refreshMutationBlocks();
			return result;
		}
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
		await refreshMutationBlocks().catch(() => undefined);
		return fail("journal_write_failed");
	}
	await refreshMutationBlocks();
	return { success: true, state: "decommissioned" };
}

export function rebaselineMutation(
	stableKey: string,
	signal?: AbortSignal,
): Promise<ModemMutationAckOutput> {
	return withRetirementKey(
		stableKey,
		(entry) =>
			entry.state === "acknowledged" || entry.state === "recommission-pending",
		signal,
		() => rebaselineHeld(stableKey),
	);
}

async function rebaselineHeld(
	stableKey: string,
): Promise<ModemMutationAckOutput> {
	const revision = mutationJournalRevision();
	const entry = await readMutationEntry(stableKey);
	if (entry === undefined) return fail("no_entry");
	if (entry.stableKey !== stableKey) return fail("state_mismatch");
	if (entry.state === "acknowledged") {
		if (!isMutationJournalRevisionCurrent(revision)) return fail("not_blocked");
		return archiveAcknowledged(
			entry,
			"force-rebaseline",
			"resume acknowledged retirement",
		);
	}
	if (entry.state !== "recommission-pending") return fail("not_blocked");

	const device = await resolveMutationDevice(entry);
	if (!isMutationJournalRevisionCurrent(revision)) return fail("not_blocked");
	if (device.status === "absent") return fail("device_absent");
	if (device.status !== "present") return fail("read_failed");

	return archiveAcknowledged(
		entry,
		"force-rebaseline",
		"operator rebaselined the device now occupying this identity",
		device.state,
	);
}
