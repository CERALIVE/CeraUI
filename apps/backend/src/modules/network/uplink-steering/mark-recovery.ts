import { logger } from "../../../helpers/logger.ts";
import { SteeringUnavailableError, type SteeringUplink } from "./contracts.ts";
import { type MarkAdmission, receiptName } from "./mark-admission.ts";
import type { MarkJournal, MarkJournalStore } from "./mark-journal.ts";
import type { MarkObservation } from "./mark-observation.ts";
import { matchesLegacy, provenByKernel } from "./mark-transition.ts";

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

/**
 * A saved collision stays unverified until an apply re-checks the kernel. An
 * unreadable journal may hide one, and start-up runs no kernel command before
 * netif readiness, so it is unverified until the first reconcile.
 */
export async function hasJournaledCollision(
	journal: MarkJournalStore,
): Promise<boolean> {
	try {
		return hasGuardedJournal(await journal.load());
	} catch (error) {
		if (!(error instanceof SteeringUnavailableError)) throw error;
		return true;
	}
}

/** Whether the kernel still has to reach the journal's committed image. */
export function markPending(
	{ base, intent }: MarkJournal,
	observed: MarkObservation,
	indices: ReadonlyMap<string, number>,
): boolean {
	return (
		intent !== undefined ||
		(base.affected.length > 0 &&
			(!observed.fence ||
				observed.guard !== receiptName(base.seq) ||
				base.claims.some(
					(claim) => indices.get(claim.ifname) !== claim.ifindex,
				)))
	);
}

/** Reports the device unverified before a collision intent reaches disk. */
export function announceCollisionIntents(
	journal: MarkJournalStore,
	unverified: () => void,
): MarkJournalStore {
	return {
		load: () => journal.load(),
		save: async (record) => {
			if (record.intent?.affected.length) unverified();
			await journal.save(record);
		},
	};
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
		// A quarantine guard yields to the journal it stood in for once that
		// journal reads back; the next apply re-publishes its receipt.
		const quarantined =
			observed.guard === "fenced_0" && hasGuardedJournal(record);
		if (
			!pendingFence &&
			!quarantined &&
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
		try {
			await journal.save(committed);
		} catch (error) {
			// Without a collision the kernel already holds the intent.
			if (hasGuardedJournal(record) || !optionalJournalFault(error))
				throw error;
			logger.warn("steering mark recovery could not be saved", { err: error });
		}
		return committed;
	}
	return record;
}

/** Journal owners, plus owners the kernel proves where the journal has none. */
export function ownedMarks(
	claims: MarkJournal["base"]["claims"],
	candidates: readonly SteeringUplink[],
	legacy: string,
): Map<string, number> {
	const owners = new Map(claims.map(({ identity, mark }) => [identity, mark]));
	for (const link of candidates) {
		if (!owners.has(link.identity) && provenByKernel(legacy, claims, link))
			owners.set(link.identity, link.mark);
	}
	return owners;
}

/**
 * Without verified marks, a contended mark keeps its one proven owner and its
 * other contenders wait. `kept` is absent when a contended mark has no proven
 * owner, so the caller must leave the kernel alone, as main does.
 */
export function keepProvenOwners(
	candidates: readonly SteeringUplink[],
	claims: MarkJournal["base"]["claims"],
	legacy: string,
): { readonly blocked: ReadonlySet<number>; readonly kept?: SteeringUplink[] } {
	const blocked = new Set<number>();
	const kept: SteeringUplink[] = [];
	let decided = true;
	for (const mark of new Set(candidates.map((link) => link.mark))) {
		const contenders = candidates.filter((link) => link.mark === mark);
		if (
			contenders.length === 1 &&
			!claims.some(
				(claim) =>
					claim.mark === mark && claim.identity !== contenders[0]?.identity,
			)
		) {
			kept.push(...contenders);
			continue;
		}
		blocked.add(mark);
		const owners = contenders.filter(
			(link) =>
				claims.some(
					(claim) => claim.identity === link.identity && claim.mark === mark,
				) || provenByKernel(legacy, claims, link),
		);
		if (owners.length === 1) kept.push(...owners);
		else decided = false;
	}
	return decided ? { blocked, kept } : { blocked };
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

/** A journal write fault that a device without collision state may ignore. */
export function optionalJournalFault(error: unknown): boolean {
	return (
		error instanceof SteeringUnavailableError ||
		(error instanceof Error && "code" in error)
	);
}
