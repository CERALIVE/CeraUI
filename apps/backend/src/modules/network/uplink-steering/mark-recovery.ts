import { SteeringUnavailableError } from "./contracts.ts";
import { type MarkAdmission, receiptName } from "./mark-admission.ts";
import type { MarkJournal, MarkJournalStore } from "./mark-journal.ts";
import type { MarkObservation } from "./mark-observation.ts";
import { matchesLegacy } from "./mark-transition.ts";

export const emptyMarkJournal: MarkJournal = {
	version: 1,
	base: { seq: 0, digest: "", claims: [], affected: [], zones: [] },
	provisional: [],
};

export function hasGuardedJournal(
	record: MarkJournal | undefined,
): record is MarkJournal {
	return Boolean(
		record?.base.affected.length || record?.intent?.affected.length,
	);
}

export async function loadIfReadable(
	journal: MarkJournalStore,
): Promise<MarkJournal | undefined> {
	try {
		return await journal.load();
	} catch (error) {
		if (!(error instanceof SteeringUnavailableError)) throw error;
		return undefined;
	}
}

export async function recoverMarkJournal(
	journal: MarkJournalStore,
	record: MarkJournal | undefined,
	observed: MarkObservation,
): Promise<MarkJournal> {
	if (!record) {
		if (observed.guard || observed.fence) quarantine();
		return emptyMarkJournal;
	}
	const { base, intent } = record;
	if (observed.guard) {
		const fenceSeq = /^fenced_(\d+)$/.exec(observed.guard)?.[1];
		const pendingFence =
			intent &&
			fenceSeq !== undefined &&
			Number(fenceSeq) > base.seq &&
			Number(fenceSeq) <= intent.seq;
		if (
			!pendingFence &&
			observed.guard !== receiptName(base.seq) &&
			(!intent || observed.guard !== receiptName(intent.seq))
		)
			quarantine();
	} else if (observed.fence || base.affected.length > 0) {
		quarantine();
	}
	// The old classifier and the transition classifier can both contain all
	// surviving claims before the departing mark's conntrack has been flushed.
	const keepsAllOwners =
		intent &&
		base.claims.every(({ identity, mark }) =>
			intent.claims.some(
				(claim) => claim.identity === identity && claim.mark === mark,
			),
		);
	if (
		intent &&
		(observed.guard === receiptName(intent.seq) ||
			(intent.affected.length === 0 &&
				keepsAllOwners &&
				matchesLegacy(observed.legacy, intent.claims)))
	) {
		const committed: MarkJournal = {
			version: 1,
			base: intent,
			provisional: [],
		};
		await journal.save(committed);
		return committed;
	}
	return record;
}

export function quarantineAdmission(
	observed: MarkObservation,
): MarkAdmission | undefined {
	if (!observed.protectedZones?.length) return undefined;
	return {
		seq: 0,
		phase: "fenced",
		zones: observed.protectedZones,
		...(observed.affected ? { affected: observed.affected } : {}),
		claims: (observed.unaffected ?? []).map((claim) => ({
			...claim,
			epoch: 0,
		})),
	};
}

export function quarantine(): never {
	throw new SteeringUnavailableError(
		"mark_collision",
		"saved steering marks disagree with the kernel; reboot to recover",
	);
}
