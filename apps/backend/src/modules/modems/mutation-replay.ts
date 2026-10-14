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
 * Startup replay of the durable modem-mutation journal.
 *
 * It runs the state-by-state table from `mutation-journal-state.ts` and nothing
 * else — the table is the contract and this module is its executor, so a change to
 * recovery behaviour is a change to a data table with a unit test rather than to
 * branchy startup code.
 *
 * It NEVER throws. A replay that could not settle every slot keeps the barrier
 * raised — unread or invalidated authority may still need its rollback — and
 * hands it to the one retry owner (`mutation-recovery-owner.ts`), which retries
 * with capped backoff until a complete readable replay lowers it. A barrier is
 * never left raised without that owner.
 */

import type { ModemMutationEntry } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	beginRecoveryBarrier,
	completeRecoveryBarrier,
	consumeRecoveryBarrierRaise,
	setRecoveryRetryOwner,
} from "../streaming/recovery-barrier.ts";

import {
	reconciledMutationJournalRevision,
	refreshMutationBlocks,
} from "./mutation-blocks.ts";
import {
	commitMutationEntry,
	journalNow,
	listMutationEntries,
	listUnreadableSlots,
	nextEntry,
	readMutationEntry,
	removeMutationEntry,
} from "./mutation-journal.ts";
import { settlePendingMutationRemovals } from "./mutation-journal-retirement.ts";
import {
	assertMutationJournalRevision,
	isMutationJournalRevisionCurrent,
	mutationJournalRevision,
} from "./mutation-journal-revision.ts";
import {
	presenceRecheckTarget,
	replayActionFor,
} from "./mutation-journal-state.ts";
import {
	type MutationRecoveryDeps,
	scheduleMutationRecovery,
	sleepUnlessAborted,
	startMutationRecovery,
	stopMutationRecovery,
} from "./mutation-recovery-owner.ts";
import { captureModemState, rollbackMutation } from "./mutation-rollback.ts";
// Side-effect imports: register each kind's rollback handler. Replay must not be
// the first caller to discover a kind has no way back — that would report an
// `unavailable` rollback for a mutation that is perfectly restorable.
import "./band-rollback.ts";
import "./usb-mode-rollback.ts";

export interface ReplaySummary {
	readonly rolledBack: number;
	readonly pruned: number;
	readonly blocked: number;
	readonly quarantined: number;
	readonly unreadable: number;
}

async function advance(
	entry: ModemMutationEntry,
	state: ModemMutationEntry["state"],
	detail: string,
): Promise<void> {
	await commitMutationEntry(nextEntry(entry, state, journalNow(), detail));
}

async function replayEntry(
	entry: ModemMutationEntry,
	tally: {
		rolledBack: number;
		pruned: number;
		blocked: number;
		quarantined: number;
	},
	revision: bigint,
): Promise<void> {
	assertMutationJournalRevision(revision);
	const action = replayActionFor(entry.state);

	if (action === "prune" || action === "resume-archive") {
		await removeMutationEntry(entry.stableKey);
		tally.pruned += 1;
		return;
	}

	if (action === "remain-blocked") {
		tally.blocked += 1;
		return;
	}

	if (action === "recheck-presence") {
		const present = (await captureModemState(entry.stableKey)) !== undefined;
		assertMutationJournalRevision(revision);
		const target = presenceRecheckTarget(entry.state, present);
		if (target === undefined) {
			tally.blocked += 1;
			return;
		}
		await advance(entry, target, "device presence re-checked at replay");
		tally.blocked += 1;
		return;
	}

	const outcome = await rollbackMutation(
		entry.kind,
		entry.stableKey,
		entry.preState,
	);
	assertMutationJournalRevision(revision);
	if (outcome === "restored") {
		await removeMutationEntry(entry.stableKey);
		tally.rolledBack += 1;
		return;
	}
	if (outcome === "absent") {
		await advance(
			entry,
			"device-absent-quarantine",
			"device absent when replay tried to roll it back",
		);
		tally.quarantined += 1;
		return;
	}
	await advance(
		entry,
		"failed",
		outcome === "unavailable"
			? "no rollback is available for this mutation kind"
			: "rollback did not restore the journaled pre-state",
	);
	tally.blocked += 1;
}

export async function runMutationReplay(): Promise<ReplaySummary> {
	const tally = { rolledBack: 0, pruned: 0, blocked: 0, quarantined: 0 };
	let unreadable = 0;
	try {
		await settlePendingMutationRemovals();
		for (const name of await listUnreadableSlots()) {
			unreadable += 1;
			logger.error("modem mutation journal slot is unreadable; left in place", {
				module: "modems",
				slot: name,
			});
		}
		// Readable entries still replay beside a damaged slot; the strict block
		// publication below vetoes completion when the inventory changed meanwhile.
		for (const hint of await listMutationEntries()) {
			try {
				const revision = mutationJournalRevision();
				const entry = await readMutationEntry(hint.stableKey);
				assertMutationJournalRevision(revision);
				if (entry === undefined) continue;
				await replayEntry(entry, tally, revision);
			} catch (err) {
				// Lost authority is an incomplete pass, never a verdict about the slot.
				unreadable += 1;
				logger.error("modem mutation replay failed for one device", {
					module: "modems",
					stableKey: hint.stableKey,
					state: hint.state,
					err,
				});
			}
		}
		await refreshMutationBlocks();
	} catch (err) {
		unreadable += 1;
		logger.error("modem mutation replay did not complete", {
			module: "modems",
			err,
		});
	}
	const summary: ReplaySummary = { ...tally, unreadable };
	logger.info("modem mutation replay finished", {
		module: "modems",
		...summary,
	});
	return summary;
}

/** Settle submitted bookkeeping and read current blocks, without hardware rollback. */
async function journalReadsCompletely(): Promise<boolean> {
	await settlePendingMutationRemovals();
	if ((await listUnreadableSlots()).length > 0) return false;
	await refreshMutationBlocks();
	return true;
}

export interface MutationRecoveryOptions {
	/** Injected clock for the retry owner's backoff. */
	readonly sleep?: MutationRecoveryDeps["sleep"];
}

/**
 * Raise the admission barrier and replay, lowering it only with readable authority. The barrier
 * is raised synchronously so it is already up before the WS server starts
 * accepting the RPCs it gates. When the replay could not read everything, the
 * retry owner takes over; a later runtime raise is retried read-only.
 */
export async function initMutationRecovery(
	options: MutationRecoveryOptions = {},
): Promise<ReplaySummary> {
	stopMutationRecovery();
	beginRecoveryBarrier();
	consumeRecoveryBarrierRaise();
	const summary = await runMutationReplay();
	const deps: MutationRecoveryDeps = {
		replay: async () => (await runMutationReplay()).unreadable === 0,
		verify: journalReadsCompletely,
		sleep: options.sleep ?? sleepUnlessAborted,
	};
	startMutationRecovery();
	setRecoveryRetryOwner({
		schedule: () => scheduleMutationRecovery(deps, "verify"),
		cancel: stopMutationRecovery,
	});
	if (
		summary.unreadable === 0 &&
		isMutationJournalRevisionCurrent(reconciledMutationJournalRevision()) &&
		completeRecoveryBarrier()
	)
		return summary;
	scheduleMutationRecovery(
		deps,
		summary.unreadable === 0 ? "verify" : "replay",
	);
	return summary;
}
