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
 * It NEVER throws. A replay that cannot complete still lowers the barrier, because
 * a barrier nobody will ever lower is worse than a device that reports honestly
 * that some identities are blocked: the blocks themselves are what keep the device
 * safe, and holding the barrier as well would strand streaming permanently on a
 * transient filesystem fault.
 */

import type { ModemMutationEntry } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	beginRecoveryBarrier,
	completeRecoveryBarrier,
} from "../streaming/recovery-barrier.ts";

import { refreshMutationBlocks } from "./mutation-blocks.ts";
import {
	commitMutationEntry,
	journalNow,
	listMutationEntries,
	listUnreadableSlots,
	nextEntry,
	removeMutationEntry,
} from "./mutation-journal.ts";
import {
	presenceRecheckTarget,
	replayActionFor,
} from "./mutation-journal-state.ts";
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
): Promise<void> {
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
		for (const name of await listUnreadableSlots()) {
			unreadable += 1;
			logger.error("modem mutation journal slot is unreadable; left in place", {
				module: "modems",
				slot: name,
			});
		}
		for (const entry of await listMutationEntries()) {
			try {
				await replayEntry(entry, tally);
			} catch (err) {
				tally.blocked += 1;
				logger.error("modem mutation replay failed for one device", {
					module: "modems",
					stableKey: entry.stableKey,
					state: entry.state,
					err,
				});
			}
		}
		await refreshMutationBlocks();
	} catch (err) {
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

/**
 * Raise the admission barrier and replay, lowering it on EVERY exit. The barrier
 * is raised synchronously so it is already up before the WS server starts
 * accepting the RPCs it gates.
 */
export async function initMutationRecovery(): Promise<ReplaySummary> {
	beginRecoveryBarrier();
	try {
		return await runMutationReplay();
	} finally {
		completeRecoveryBarrier();
	}
}
