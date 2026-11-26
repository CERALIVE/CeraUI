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
 * Projects the durable journal onto the interlock's fail-closed block set, and
 * onto the operator-facing list.
 *
 * The journal is the truth and this is the only thing that publishes it, so
 * "which devices are blocked" has exactly one derivation. The mapping from a
 * journal state to a REFUSAL is where the two different kinds of blocking meet:
 * every blocked state refuses mutations to its own identity, but only the states
 * whose device we still expect to answer for hold GLOBAL stream autostart — an
 * operator-confirmed decommission releases streaming precisely so a destroyed
 * modem cannot permanently strand the remaining links.
 */

import { createUsbEnumerator } from "@ceralive/modem-control";
import {
	deriveModemStableKey,
	type ModemMutationBlock,
	type ModemMutationEntry,
	type ModemMutationRefusal,
	type ModemMutationState,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	type MutationBlock,
	setMutationBlocks,
} from "../streaming/lifecycle-admission.ts";

import { readMutationUdevExportDb } from "./modem-id-path-source.ts";
import { listMutationEntries, mutationSlotName } from "./mutation-journal.ts";
import {
	assertMutationJournalRevision,
	isMutationJournalRevisionCurrent,
	mutationJournalRevision,
} from "./mutation-journal-revision.ts";
import { blocksMutations, blocksStreaming } from "./mutation-journal-state.ts";

const REFUSAL_BY_STATE: Readonly<
	Partial<Record<ModemMutationState, ModemMutationRefusal>>
> = {
	armed: "mutation_in_progress",
	executing: "mutation_in_progress",
	failed: "mutation_blocked",
	"device-absent-quarantine": "mutation_blocked",
	decommissioned: "device_decommissioned",
	"recommission-pending": "rebaseline_required",
};

export interface MutationBlockDeps {
	listEntries(
		onUnreadable: (slot: string) => void,
	): Promise<readonly ModemMutationEntry[]>;
	presentStableKeys(): Promise<ReadonlySet<string>>;
}

/**
 * The sentinel a failed enumeration answers with. It is compared by IDENTITY, so
 * "we could not look" can never be mistaken for "we looked and found nothing".
 */
export const PRESENCE_UNKNOWN: ReadonlySet<string> = new Set<string>();

async function enumeratePresentKeys(): Promise<ReadonlySet<string>> {
	const present = new Set<string>();
	try {
		const devices = await createUsbEnumerator({
			readUdevDatabase: readMutationUdevExportDb,
		}).enumerate();
		for (const device of devices) {
			const key = deriveModemStableKey(device.physicalUid);
			if (key !== undefined) present.add(key);
		}
	} catch (err) {
		// An unreadable bus is a statement about the READ, never about the devices.
		// Answering "nothing is present" would quarantine every journaled modem.
		logger.warn("could not enumerate USB devices for mutation-block presence", {
			module: "modems",
			err,
		});
		return PRESENCE_UNKNOWN;
	}
	return present;
}

export const defaultMutationBlockDeps: MutationBlockDeps = {
	listEntries: (onUnreadable) =>
		listMutationEntries(undefined, false, onUnreadable),
	presentStableKeys: enumeratePresentKeys,
};

let activeDeps: MutationBlockDeps = defaultMutationBlockDeps;

export function setMutationBlockDeps(deps: Partial<MutationBlockDeps>): void {
	activeDeps = { ...defaultMutationBlockDeps, ...deps };
}

export function resetMutationBlockDeps(): void {
	activeDeps = defaultMutationBlockDeps;
}

interface MutationBlockPublication {
	readonly blocks: readonly ModemMutationBlock[];
	readonly readableKeys: ReadonlySet<string>;
	readonly revision: bigint;
}

let publication: MutationBlockPublication = {
	blocks: [],
	readableKeys: new Set(),
	revision: mutationJournalRevision(),
};

export function currentMutationBlockPublication(): MutationBlockPublication {
	return publication;
}

export function reconciledMutationJournalRevision(): bigint {
	return publication.revision;
}

export function currentMutationBlocks(): readonly ModemMutationBlock[] {
	return publication.blocks;
}

interface BlockCensus {
	readonly entries: readonly ModemMutationEntry[];
	readonly unreadable: readonly string[];
	readonly revision: bigint;
}

/**
 * Each damaged slot moves the revision once, by this very read. A census that
 * counted those faults itself is stale only when the revision moved further.
 */
async function readBlockCensus(deps: MutationBlockDeps): Promise<BlockCensus> {
	const before = mutationJournalRevision();
	const unreadable: string[] = [];
	const entries = await deps.listEntries((slot) => unreadable.push(slot));
	return {
		entries,
		unreadable,
		revision: before + BigInt(unreadable.length),
	};
}

/** Re-derive the block set from disk and publish it to the interlock. */
export async function refreshMutationBlocks(
	deps: MutationBlockDeps = activeDeps,
): Promise<readonly ModemMutationBlock[]> {
	return (await reconcileMutationBlocks(deps)).blocks;
}

/** The cold list obtains device presence in its own single, bounded read. */
export async function publishBootMutationBlocks(): Promise<void> {
	await refreshMutationBlocks({
		...activeDeps,
		presentStableKeys: async () => PRESENCE_UNKNOWN,
	});
}

/** The same publication, naming the damaged slots its view could not include. */
export async function reconcileMutationBlocks(
	deps: MutationBlockDeps = activeDeps,
): Promise<{
	readonly blocks: readonly ModemMutationBlock[];
	readonly unreadable: readonly string[];
}> {
	let census = await readBlockCensus(deps);
	if (!isMutationJournalRevisionCurrent(census.revision)) {
		census = await readBlockCensus(deps);
	}
	const { entries, unreadable, revision } = census;
	const blocking = entries.filter((entry) => blocksMutations(entry.state));
	const present =
		blocking.length === 0 ? PRESENCE_UNKNOWN : await deps.presentStableKeys();
	const presenceKnown = present !== PRESENCE_UNKNOWN;
	const readable: ModemMutationBlock[] = blocking.map((entry) => ({
		stableKey: entry.stableKey,
		kind: entry.kind,
		state: entry.state,
		updatedAt: entry.updatedAt,
		// A presence answer we could not obtain is reported as PRESENT, because a
		// device we cannot rule out is a device whose fail-closed handling must
		// keep running rather than being downgraded to quarantine.
		devicePresent: presenceKnown ? present.has(entry.stableKey) : true,
		blocksStreaming: blocksStreaming(entry.state),
		...(entry.detail === undefined ? {} : { detail: entry.detail }),
	}));

	assertMutationJournalRevision(revision);
	// Damage is not absence: a slot that cannot be read keeps its published row.
	const blocks = [
		...readable,
		...publication.blocks.filter((block) =>
			unreadable.includes(`${mutationSlotName(block.stableKey)}.json`),
		),
	];
	setMutationBlocks(
		blocks.map(
			(block): MutationBlock => ({
				stableKey: block.stableKey,
				refusal: REFUSAL_BY_STATE[block.state] ?? "mutation_blocked",
				blocksStreaming: block.blocksStreaming,
			}),
		),
	);
	publication = {
		blocks,
		readableKeys: new Set(blocking.map((entry) => entry.stableKey)),
		revision,
	};
	return { blocks, unreadable };
}
