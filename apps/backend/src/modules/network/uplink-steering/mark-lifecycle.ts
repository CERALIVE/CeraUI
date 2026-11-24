import { logger } from "../../../helpers/logger.ts";
import type { PreparedSteeringState } from "./applier.ts";
import { SteeringUnavailableError, type SteeringUplink } from "./contracts.ts";
import { receiptName } from "./mark-admission.ts";
import {
	assignSteeringMarks,
	hasNaturalMarkCollision,
} from "./mark-allocation.ts";
import { MarkEvidence, type MarkEvidenceDeps } from "./mark-evidence.ts";
import type { MarkImage, MarkJournal } from "./mark-journal.ts";
import {
	keepProvenOwners,
	markPending,
	optionalJournalFault,
	ownedMarks,
} from "./mark-recovery.ts";
import {
	affectedMarks,
	applyMarkTransition,
	type MarkTransitionEffects,
	planMarkIntent,
	steeringDigest,
} from "./mark-transition.ts";

interface MarkLifecycleDeps extends MarkTransitionEffects, MarkEvidenceDeps {
	readonly linkIndex: (ifname: string) => Promise<number>;
	readonly applyLegacy: (
		previous: PreparedSteeringState | undefined,
		next: PreparedSteeringState,
	) => Promise<void>;
}

export class SteeringMarkLifecycle {
	readonly #deps: MarkLifecycleDeps;
	readonly #known: MarkEvidence;
	#legacyOnly = false;
	#indices = new Map<string, number>();
	#blocked = false;

	constructor(deps: MarkLifecycleDeps) {
		this.#deps = deps;
		this.#known = new MarkEvidence(deps);
	}

	get guarded(): boolean {
		return this.#known.guarded;
	}

	/** A contender waits for verified marks while its proven owner steers. */
	get blocked(): boolean {
		return this.#blocked;
	}

	/** Main's path ran without the kernel ever being read in this process. */
	get unverified(): boolean {
		return this.#known.unverified;
	}

	get pending(): boolean {
		return markPending(this.#known.record, this.#known.observed, this.#indices);
	}

	affects(mark: number): boolean {
		const { affected, observed, quarantined } = this.#known;
		return (
			affected.has(mark) ||
			observed.affected?.includes(mark) === true ||
			(quarantined && !observed.affected?.length)
		);
	}

	async marks(
		candidates: readonly SteeringUplink[],
	): Promise<ReadonlyMap<string, number>> {
		this.#blocked = false;
		const collision = hasNaturalMarkCollision(candidates);
		const reuse = candidates.some(({ identity, mark }) =>
			this.#known.record.base.claims.some(
				(claim) => claim.mark === mark && claim.identity !== identity,
			),
		);
		const strict = collision || reuse || this.guarded;
		if (strict || !this.#legacyOnly || this.#known.record.intent) {
			try {
				await this.#known.read(strict);
			} catch (error) {
				if (this.guarded || (!collision && !reuse) || !(error instanceof Error))
					throw error;
				const { blocked, kept } = keepProvenOwners(
					candidates,
					this.#known.record.base.claims,
					this.#known.observed.legacy,
				);
				this.#known.affected = blocked;
				// Unverified marks never move or evict a proven owner.
				if (kept === undefined)
					throw new SteeringUnavailableError("mark_collision", error.message);
				this.#known.unrecorded = true;
				this.#legacyOnly = false;
				this.#known.quarantined = false;
				this.#blocked = true;
				return assignSteeringMarks(kept, new Map());
			}
			this.#legacyOnly = !this.guarded && !this.#known.unrecorded;
		}
		const { base } = this.#known.record;
		this.#indices.clear();
		if (base.affected.length > 0) {
			for (const { ifname } of candidates)
				this.#indices.set(ifname, await this.#deps.linkIndex(ifname));
		}
		const incumbents = ownedMarks(
			base.claims,
			candidates,
			this.#known.observed.legacy,
		);
		const assigned = assignSteeringMarks(candidates, incumbents);
		this.#known.affected = affectedMarks(
			this.#known.record,
			candidates,
			assigned,
		);
		return assigned;
	}

	async apply(
		previous: PreparedSteeringState | undefined,
		next: PreparedSteeringState,
	): Promise<void> {
		if (next.clientZones.length === 0) await this.marks([]);
		const base = this.#known.record.base;
		const digest = steeringDigest(next);
		if (
			!this.#known.record.intent &&
			base.affected.length > 0 &&
			base.digest === digest &&
			this.#known.observed.guard === receiptName(base.seq) &&
			!this.pending
		) {
			for (const route of next.routes) await this.#deps.ensure(route);
			return;
		}
		const affected = this.#known.affected;
		if (this.#known.unrecorded && !this.guarded) {
			await this.#deps.applyLegacy(previous, next);
			return;
		}
		let intent: MarkImage;
		let former: Awaited<ReturnType<typeof planMarkIntent>>["former"];
		try {
			({ former, ...intent } = await planMarkIntent(
				this.#known.record,
				next,
				digest,
				affected,
				this.#known.observed.legacy,
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
			this.#known.record = pending;
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
			this.#known.observed = {
				...this.#known.observed,
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
		this.#known.record = committed;
	}
}
