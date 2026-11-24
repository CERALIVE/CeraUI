import { logger } from "../../../helpers/logger.ts";
import type { PreparedSteeringState } from "./applier.ts";
import { SteeringUnavailableError, type SteeringUplink } from "./contracts.ts";
import { receiptName } from "./mark-admission.ts";
import {
	assignSteeringMarks,
	hasNaturalMarkCollision,
} from "./mark-allocation.ts";
import type {
	MarkImage,
	MarkJournal,
	MarkJournalStore,
} from "./mark-journal.ts";
import type { MarkObservation } from "./mark-observation.ts";
import {
	emptyMarkJournal,
	hasGuardedJournal,
	keepProvenOwners,
	loadIfReadable,
	markPending,
	optionalJournalFault,
	ownedMarks,
	quarantineAdmission,
	recoverMarkJournal,
} from "./mark-recovery.ts";
import {
	affectedMarks,
	applyMarkTransition,
	type MarkTransitionEffects,
	planMarkIntent,
	steeringDigest,
} from "./mark-transition.ts";

interface MarkLifecycleDeps extends MarkTransitionEffects {
	readonly journal: MarkJournalStore;
	readonly observe: () => Promise<MarkObservation>;
	readonly linkIndex: (ifname: string) => Promise<number>;
	readonly applyLegacy: (
		previous: PreparedSteeringState | undefined,
		next: PreparedSteeringState,
	) => Promise<void>;
}

const noObservation: MarkObservation = { guard: "", fence: false, legacy: "" };

export class SteeringMarkLifecycle {
	readonly #deps: MarkLifecycleDeps;
	#record = emptyMarkJournal;
	#observed = noObservation;
	#legacyOnly = false;
	#unrecorded = false;
	#indices = new Map<string, number>();
	#affected: ReadonlySet<number> = new Set();
	#quarantined = false;
	#blocked = false;

	constructor(deps: MarkLifecycleDeps) {
		this.#deps = deps;
	}

	get guarded(): boolean {
		return (
			this.#observed.fence ||
			this.#observed.guard !== "" ||
			this.#record.base.affected.length > 0 ||
			(this.#record.intent?.affected.length ?? 0) > 0
		);
	}

	/** A contender waits for verified marks while its proven owner steers. */
	get blocked(): boolean {
		return this.#blocked;
	}

	get pending(): boolean {
		return markPending(this.#record, this.#observed, this.#indices);
	}

	affects(mark: number): boolean {
		return (
			this.#affected.has(mark) ||
			this.#observed.affected?.includes(mark) === true ||
			(this.#quarantined && !this.#observed.affected?.length)
		);
	}

	async #read(strict: boolean): Promise<MarkJournal> {
		this.#unrecorded = false;
		let observed: MarkObservation;
		try {
			observed = await this.#deps.observe();
		} catch (error) {
			const saved = await loadIfReadable(this.#deps.journal);
			if (hasGuardedJournal(saved)) this.#rememberAffected(saved);
			if (strict || this.guarded) throw error;
			this.#unrecorded = true;
			return this.#record;
		}
		this.#observed = observed;
		try {
			const record = await this.#deps.journal.load();
			if (hasGuardedJournal(record)) this.#rememberAffected(record);
			const recovered = await recoverMarkJournal(
				this.#deps.journal,
				record,
				observed,
			);
			this.#quarantined = false;
			return recovered;
		} catch (error) {
			if (
				!strict &&
				!this.guarded &&
				error instanceof SteeringUnavailableError
			) {
				this.#unrecorded = true;
				return emptyMarkJournal;
			}
			this.#quarantined = true;
			const admission = quarantineAdmission(observed);
			if (error instanceof SteeringUnavailableError && admission)
				await this.#deps.guard(admission);
			throw error;
		}
	}

	#rememberAffected(record: MarkJournal): void {
		this.#record = record;
		this.#affected = new Set([
			...record.base.affected,
			...(record.intent?.affected ?? []),
		]);
	}

	async marks(
		candidates: readonly SteeringUplink[],
	): Promise<ReadonlyMap<string, number>> {
		this.#blocked = false;
		const collision = hasNaturalMarkCollision(candidates);
		const reuse = candidates.some(({ identity, mark }) =>
			this.#record.base.claims.some(
				(claim) => claim.mark === mark && claim.identity !== identity,
			),
		);
		const strict = collision || reuse || this.guarded;
		if (strict || !this.#legacyOnly || this.#record.intent) {
			try {
				this.#record = await this.#read(strict);
			} catch (error) {
				if (this.guarded || (!collision && !reuse) || !(error instanceof Error))
					throw error;
				const { blocked, kept } = keepProvenOwners(
					candidates,
					this.#record.base.claims,
					this.#observed.legacy,
				);
				this.#affected = blocked;
				// Unverified marks never move or evict a proven owner.
				if (kept === undefined)
					throw new SteeringUnavailableError("mark_collision", error.message);
				this.#unrecorded = true;
				this.#legacyOnly = false;
				this.#quarantined = false;
				this.#blocked = true;
				return assignSteeringMarks(kept, new Map());
			}
			this.#legacyOnly = !this.guarded && !this.#unrecorded;
		}
		const { base } = this.#record;
		this.#indices.clear();
		if (base.affected.length > 0) {
			for (const { ifname } of candidates)
				this.#indices.set(ifname, await this.#deps.linkIndex(ifname));
		}
		const incumbents = ownedMarks(
			base.claims,
			candidates,
			this.#observed.legacy,
		);
		const assigned = assignSteeringMarks(candidates, incumbents);
		this.#affected = affectedMarks(this.#record, candidates, assigned);
		return assigned;
	}

	async apply(
		previous: PreparedSteeringState | undefined,
		next: PreparedSteeringState,
	): Promise<void> {
		if (next.clientZones.length === 0) await this.marks([]);
		const base = this.#record.base;
		const digest = steeringDigest(next);
		if (
			!this.#record.intent &&
			base.affected.length > 0 &&
			base.digest === digest &&
			this.#observed.guard === receiptName(base.seq) &&
			!this.pending
		) {
			for (const route of next.routes) await this.#deps.ensure(route);
			return;
		}
		const affected = this.#affected;
		if (this.#unrecorded && !this.guarded) {
			await this.#deps.applyLegacy(previous, next);
			return;
		}
		let intent: MarkImage;
		let former: Awaited<ReturnType<typeof planMarkIntent>>["former"];
		try {
			({ former, ...intent } = await planMarkIntent(
				this.#record,
				next,
				digest,
				affected,
				this.#observed.legacy,
				(ifname) => {
					const index = this.#indices.get(ifname);
					return index === undefined
						? this.#deps.linkIndex(ifname)
						: Promise.resolve(index);
				},
			));
			const pending: MarkJournal = {
				version: 1,
				base,
				intent,
				provisional: [...former],
			};
			await this.#deps.journal.save(pending);
			this.#record = pending;
		} catch (error) {
			if (affected.size > 0 || !optionalJournalFault(error)) throw error;
			logger.warn("steering mark history could not be saved", { err: error });
			await this.#deps.applyLegacy(previous, next);
			return;
		}
		if (affected.size === 0) await this.#deps.applyLegacy(previous, next);
		else {
			await applyMarkTransition(this.#deps, base, intent, former, next);
			// The transition just published this receipt, fence and binding.
			this.#observed = {
				...this.#observed,
				guard: receiptName(intent.seq),
				fence: true,
			};
			this.#indices = new Map(intent.claims.map((c) => [c.ifname, c.ifindex]));
		}
		const committed: MarkJournal = {
			version: 1,
			base: intent,
			provisional: [],
		};
		try {
			await this.#deps.journal.save(committed);
		} catch (error) {
			if (affected.size > 0 || !optionalJournalFault(error)) throw error;
			logger.warn("steering mark history could not be committed", {
				err: error,
			});
		}
		this.#record = committed;
	}
}
