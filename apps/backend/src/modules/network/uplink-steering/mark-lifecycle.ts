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
	loadIfReadable,
	optionalJournalFault,
	quarantineAdmission,
	recoverMarkJournal,
} from "./mark-recovery.ts";
import {
	affectedMarks,
	applyMarkTransition,
	type MarkTransitionEffects,
	matchesLegacy,
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

	get pending(): boolean {
		const { base, intent } = this.#record;
		return (
			intent !== undefined ||
			(base.affected.length > 0 &&
				(!this.#observed.fence ||
					base.claims.some(
						(claim) => this.#indices.get(claim.ifname) !== claim.ifindex,
					)))
		);
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
				const blocked = new Set(
					candidates
						.filter(
							({ identity, mark }) =>
								candidates.filter((link) => link.mark === mark).length > 1 ||
								this.#record.base.claims.some(
									(claim) => claim.mark === mark && claim.identity !== identity,
								),
						)
						.map(({ mark }) => mark),
				);
				const unaffected = candidates.filter(({ mark }) => !blocked.has(mark));
				this.#affected = blocked;
				if (unaffected.length === 0) throw error;
				// No guard owns these natural marks. Leave collision claims untouched
				// and let main's applier keep the independent links available.
				this.#unrecorded = true;
				this.#legacyOnly = false;
				this.#quarantined = false;
				return assignSteeringMarks(unaffected, new Map());
			}
			this.#legacyOnly = !this.guarded && !this.#unrecorded;
		}
		const { base } = this.#record;
		this.#indices.clear();
		if (base.affected.length > 0) {
			for (const { ifname } of candidates)
				this.#indices.set(ifname, await this.#deps.linkIndex(ifname));
		}
		const incumbents = new Map(
			base.claims.map(({ identity, mark }) => [identity, mark]),
		);
		if (base.seq === 0) {
			for (const uplink of candidates) {
				if (matchesLegacy(this.#observed.legacy, [uplink]))
					incumbents.set(uplink.identity, uplink.mark);
			}
		}
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
		else await applyMarkTransition(this.#deps, base, intent, former, next);
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
