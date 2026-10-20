import type {
	ModemMutationAckOutput,
	ModemMutationEntry,
} from "@ceraui/rpc/schemas";

import {
	awaitModemMutationRelease,
	tryAcquireModemJournalKey,
} from "../streaming/lifecycle-admission.ts";

import { readMutationEntry } from "./mutation-journal.ts";

const RETIREMENT_ACQUISITIONS = 3;

/**
 * Run one operator retirement under the stable key's mutation lease, through
 * its awaited transition, unlink/rename, parent fsync and refresh.
 *
 * Eligibility is read BEFORE contention is considered: a slot this action would
 * refuse (armed or executing hardware work included) answers today's refusal
 * immediately and never waits. An eligible slot whose key is held is a
 * bookkeeping tail or another retirement; wait for that holder, then reread
 * from scratch. Three acquisitions bound a holder chain; exhaustion or
 * cancellation answers `state_mismatch`, meaning the entry could not be retired
 * under this observation, never that hardware disagreed.
 *
 * The lease covers `stableKey` alone, so each `retire` rereads under it and
 * refuses with `state_mismatch` a record naming any other key: no retirement
 * writes or deletes a slot whose lease it does not hold.
 */
export async function withRetirementKey(
	stableKey: string,
	eligible: (entry: ModemMutationEntry) => boolean,
	signal: AbortSignal | undefined,
	retire: () => Promise<ModemMutationAckOutput>,
): Promise<ModemMutationAckOutput> {
	for (let attempt = 1; ; attempt++) {
		const entry = await readMutationEntry(stableKey);
		if (entry === undefined) return { success: false, error: "no_entry" };
		if (!eligible(entry)) return { success: false, error: "not_blocked" };
		const lease = tryAcquireModemJournalKey(stableKey);
		if (lease !== undefined) {
			try {
				return await retire();
			} finally {
				lease.release();
			}
		}
		if (
			attempt >= RETIREMENT_ACQUISITIONS ||
			!(await awaitModemMutationRelease(stableKey, signal))
		)
			return { success: false, error: "state_mismatch" };
	}
}
