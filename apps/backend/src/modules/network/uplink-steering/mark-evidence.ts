import { SteeringUnavailableError } from "./contracts.ts";
import type { MarkAdmission } from "./mark-admission.ts";
import type { MarkJournal, MarkJournalStore } from "./mark-journal.ts";
import type { MarkObservation } from "./mark-observation.ts";
import { matchesLegacy } from "./mark-ownership.ts";
import {
	emptyMarkJournal,
	hasGuardedJournal,
	loadIfReadable,
	quarantineAdmission,
	recoverMarkJournal,
} from "./mark-recovery.ts";

export interface MarkEvidenceDeps {
	readonly journal: MarkJournalStore;
	readonly observe: () => Promise<MarkObservation>;
	readonly guard: (admission: MarkAdmission) => Promise<void>;
}

const noObservation: MarkObservation = { guard: "", fence: false, legacy: "" };

/**
 * What the steering lifecycle knows about the kernel and its journal. Every
 * mark decision reads it, and it holds one rule: beyond main's applier the
 * lifecycle acts only on what a successful kernel observation corroborates in
 * a readable journal. Anything less leaves main's path or no action at all.
 */
export class MarkEvidence {
	readonly #deps: MarkEvidenceDeps;
	record = emptyMarkJournal;
	observed = noObservation;
	/** The last read proved nothing: only main's applier may act. */
	unrecorded = false;
	/** Nor can it rule out collision state, so status must not be available. */
	unverified = false;
	quarantined = false;
	affected: ReadonlySet<number> = new Set();

	constructor(deps: MarkEvidenceDeps) {
		this.#deps = deps;
	}

	get guarded(): boolean {
		return (
			this.observed.fence ||
			this.observed.guard !== "" ||
			this.record.base.affected.length > 0 ||
			(this.record.intent?.affected.length ?? 0) > 0
		);
	}

	async read(strict: boolean): Promise<void> {
		this.unrecorded = false;
		this.unverified = false;
		let observed: MarkObservation;
		try {
			observed = await this.#deps.observe();
		} catch (error) {
			const saved = await loadIfReadable(this.#deps.journal);
			if (hasGuardedJournal(saved)) this.remember(saved);
			if (strict || this.guarded) throw error;
			this.unrecorded = true;
			// Before this process has seen the kernel, a missing or unreadable
			// journal cannot rule out a surviving guard.
			this.unverified = saved === undefined && this.observed === noObservation;
			return;
		}
		this.observed = observed;
		try {
			const record = await this.#deps.journal.load();
			if (hasGuardedJournal(record)) this.remember(record);
			this.record = corroborated(
				await recoverMarkJournal(this.#deps.journal, record, observed),
				observed,
			);
			this.quarantined = false;
		} catch (error) {
			if (
				!strict &&
				!this.guarded &&
				error instanceof SteeringUnavailableError
			) {
				this.unrecorded = true;
				this.record = emptyMarkJournal;
				return;
			}
			this.quarantined = true;
			const admission = quarantineAdmission(observed);
			if (error instanceof SteeringUnavailableError && admission)
				await this.#deps.guard(admission);
			throw error;
		}
	}

	remember(record: MarkJournal): void {
		this.record = record;
		this.affected = new Set([
			...record.base.affected,
			...(record.intent?.affected ?? []),
		]);
	}
}

/**
 * Without collision state the kernel's share ruleset is main's own record of
 * which interface carries each mark, so a claim it contradicts was left by a
 * skipped write or a downgrade and proves nothing.
 */
function corroborated(
	record: MarkJournal,
	observed: MarkObservation,
): MarkJournal {
	if (
		record.base.affected.length > 0 ||
		(record.intent?.affected.length ?? 0) > 0 ||
		!observed.legacy
	)
		return record;
	const claims = record.base.claims.filter((claim) =>
		matchesLegacy(observed.legacy, [claim]),
	);
	return { ...record, base: { ...record.base, claims } };
}
