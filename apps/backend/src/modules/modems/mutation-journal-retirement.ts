import type { ModemMutationEntry } from "@ceraui/rpc/schemas";
import { tryAcquireModemJournalKey } from "../streaming/lifecycle-admission.ts";
import { beginRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import {
	commitMutationEntry,
	type MutationJournalDeps,
	readMutationEntry,
} from "./mutation-journal.ts";
import {
	assertMutationJournalRevision,
	mutationJournalRevision,
	withMutationJournalChange,
} from "./mutation-journal-revision.ts";

type DirectoryAcknowledgement = {
	readonly sync: () => Promise<void>;
};
const pending = new Map<string, DirectoryAcknowledgement>();
const failedTransitions = new Map<string, ModemMutationEntry>();

export async function persistMutationFailure(
	entry: ModemMutationEntry,
): Promise<void> {
	try {
		await commitMutationEntry(entry);
	} catch {
		failedTransitions.set(entry.stableKey, entry);
		beginRecoveryBarrier();
	}
}

async function acknowledge(
	dir: string,
	own: DirectoryAcknowledgement,
): Promise<void> {
	try {
		await own.sync();
		if (pending.get(dir) === own) pending.delete(dir);
	} catch (error) {
		beginRecoveryBarrier();
		throw error;
	}
}

export async function acknowledgeMutationRemoval(
	deps: MutationJournalDeps,
): Promise<void> {
	const own = { sync: () => deps.fs.fsyncDir(deps.dir) };
	pending.set(deps.dir, own);
	await acknowledge(deps.dir, own);
}

// Retry directory acknowledgement only: never repeat a pathname deletion from old authority.
export async function settlePendingMutationRemovals(): Promise<void> {
	for (const [dir, own] of pending) {
		if (pending.get(dir) !== own) continue;
		await withMutationJournalChange(() => acknowledge(dir, own));
	}
	for (const [key, own] of failedTransitions) {
		await withHeldJournalKey(key, async () => {
			const revision = mutationJournalRevision();
			const current = await readMutationEntry(key);
			assertMutationJournalRevision(revision);
			if (
				current?.attemptId === own.attemptId &&
				["armed", "executing", "completed", "failed"].includes(current.state)
			) {
				await commitMutationEntry(own);
			}
			if (failedTransitions.get(key) === own) failedTransitions.delete(key);
		});
	}
}

/** Recovery never waits for a key: a held key is an incomplete pass, retried later. */
export async function withHeldJournalKey<T>(
	stableKey: string,
	work: () => Promise<T>,
): Promise<T> {
	const lease = tryAcquireModemJournalKey(stableKey);
	if (lease === undefined)
		throw new Error("modem mutation journal key is held; recovery retries");
	try {
		return await work();
	} finally {
		lease.release();
	}
}

export function resetPendingMutationRemovals(): void {
	pending.clear();
	failedTransitions.clear();
}
