import { beginRecoveryBarrier } from "../streaming/recovery-barrier.ts";

let revision = 0n;
let writers = 0;

export function mutationJournalRevision(): bigint {
	return revision;
}

export function isMutationJournalRevisionCurrent(
	readRevision: bigint,
): boolean {
	return writers === 0 && readRevision === revision;
}

export async function withMutationJournalChange<T>(
	change: () => Promise<T>,
): Promise<T> {
	revision++;
	writers++;
	try {
		return await change();
	} finally {
		writers--;
		revision++;
	}
}

export function noteMutationJournalReadFault(): void {
	revision++;
	beginRecoveryBarrier();
}

export class MutationJournalRevisionError extends Error {
	override readonly name = "MutationJournalRevisionError";
	constructor() {
		super("mutation journal changed during reconciliation");
	}
}

export function assertMutationJournalRevision(readRevision: bigint): void {
	if (isMutationJournalRevisionCurrent(readRevision)) return;
	beginRecoveryBarrier();
	throw new MutationJournalRevisionError();
}
