import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PreparedSteeringState, UplinkRoutePlan } from "./applier.ts";
import {
	type ClientZone,
	SteeringUnavailableError,
	type SteeringUplink,
} from "./contracts.ts";
import { type MarkAdmission, receiptName } from "./mark-admission.ts";
import { assignSteeringMarks } from "./mark-allocation.ts";
import type {
	MarkClaim,
	MarkImage,
	MarkJournal,
	MarkJournalStore,
} from "./mark-journal.ts";
import { buildShareRuleset } from "./ruleset.ts";

interface MarkLifecycleDeps {
	readonly journal: MarkJournalStore;
	readonly observe: () => Promise<{
		readonly guard: string;
		readonly legacy: string;
		readonly fence: boolean;
		readonly protectedZones?: readonly ClientZone[];
	}>;
	readonly linkIndex: (ifname: string) => Promise<number>;
	readonly armFence: () => Promise<void>;
	readonly guard: (admission: MarkAdmission) => Promise<void>;
	readonly retire: (mark: number) => Promise<void>;
	readonly inventory?: () => Promise<ReadonlySet<number>>;
	readonly ensure: (route: UplinkRoutePlan) => Promise<unknown>;
	readonly flush: (mark: number) => Promise<void>;
	readonly publish: (ruleset: string, active: boolean) => Promise<void>;
	readonly applyLegacy: (
		previous: PreparedSteeringState | undefined,
		next: PreparedSteeringState,
	) => Promise<void>;
	readonly notifyRetired?: (claim: MarkClaim) => void;
}

const empty: MarkImage = {
	seq: 0,
	digest: "",
	claims: [],
	affected: [],
	zones: [],
};

function matchesLegacy(legacy: string, image: MarkImage): boolean {
	if (image.claims.length === 0) return false;
	return image.claims.every(({ ifname, mark }) =>
		legacy
			.split("\n")
			.some(
				(line) =>
					line.includes(`0x${mark.toString(16)} `) &&
					line.includes(`oifname "${ifname}" masquerade`),
			),
	);
}

function quarantine(): never {
	throw new SteeringUnavailableError(
		"mark_collision",
		"saved steering marks disagree with the kernel; reboot to recover",
	);
}

function sameBinding(a: MarkClaim, b: MarkClaim | undefined): boolean {
	return (
		b !== undefined &&
		a.identity === b.identity &&
		a.ifindex === b.ifindex &&
		a.sourceAddress === b.sourceAddress
	);
}

export class SteeringMarkLifecycle {
	readonly #deps: MarkLifecycleDeps;
	#record: MarkJournal = { version: 1, base: empty, provisional: [] };
	#observed: Awaited<ReturnType<MarkLifecycleDeps["observe"]>> | undefined;
	#natural: readonly SteeringUplink[] = [];
	#indices = new Map<string, number>();

	constructor(deps: MarkLifecycleDeps) {
		this.#deps = deps;
	}

	async #read(): Promise<MarkJournal> {
		const observed = await this.#deps.observe();
		this.#observed = observed;
		try {
			return await this.#recover(observed);
		} catch (error) {
			if (
				error instanceof SteeringUnavailableError &&
				observed.protectedZones?.length
			) {
				await this.#deps.guard({
					seq: 0,
					phase: "fenced",
					zones: observed.protectedZones,
					claims: [],
				});
			}
			throw error;
		}
	}

	async #recover(
		observed: Awaited<ReturnType<MarkLifecycleDeps["observe"]>>,
	): Promise<MarkJournal> {
		const record = await this.#deps.journal.load();
		if (record === undefined) {
			if (observed.guard || observed.fence) quarantine();
			return { version: 1, base: empty, provisional: [] };
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
		if (
			intent &&
			(observed.guard === receiptName(intent.seq) ||
				(intent.affected.length === 0 &&
					matchesLegacy(observed.legacy, intent)))
		) {
			const value: MarkJournal = { version: 1, base: intent, provisional: [] };
			await this.#deps.journal.save(value);
			return value;
		}
		return record;
	}

	async marks(
		candidates: readonly SteeringUplink[],
	): Promise<ReadonlyMap<string, number>> {
		this.#record = await this.#read();
		this.#natural = candidates;
		const { base } = this.#record;
		this.#indices.clear();
		if (base.affected.length > 0) {
			for (const { ifname } of candidates)
				this.#indices.set(ifname, await this.#deps.linkIndex(ifname));
		}
		const incumbents = new Map(
			base.claims.map(({ identity, mark }) => [identity, mark]),
		);
		if (base.seq === 0 && this.#observed?.legacy) {
			for (const uplink of candidates) {
				if (
					matchesLegacy(this.#observed.legacy, {
						...empty,
						claims: [
							{ ...uplink, ifindex: 1, table: "", sourceAddress: "", epoch: 0 },
						],
					})
				)
					incumbents.set(uplink.identity, uplink.mark);
			}
		}
		return assignSteeringMarks(candidates, incumbents);
	}

	get pending(): boolean {
		const { base, intent } = this.#record;
		return (
			intent !== undefined ||
			(base.affected.length > 0 &&
				(!this.#observed?.fence ||
					base.claims.some(
						(claim) => this.#indices.get(claim.ifname) !== claim.ifindex,
					)))
		);
	}

	get guarded(): boolean {
		return (
			this.#record.base.affected.length > 0 ||
			(this.#record.intent?.affected.length ?? 0) > 0
		);
	}

	async apply(
		previous: PreparedSteeringState | undefined,
		next: PreparedSteeringState,
	): Promise<void> {
		if (next.clientZones.length === 0) await this.marks([]);
		const { base, intent, provisional } = this.#record;
		const digest = createHash("sha256")
			.update(JSON.stringify(next))
			.digest("hex");
		if (
			!intent &&
			base.affected.length > 0 &&
			base.digest === digest &&
			this.#observed?.guard === receiptName(base.seq) &&
			!this.pending
		) {
			for (const route of next.routes) await this.#deps.ensure(route);
			return;
		}
		const seq = (intent?.seq ?? base.seq) + 1;
		if (seq > 0xffffffff) quarantine();
		const affected = new Set(base.affected);
		for (const natural of this.#natural) {
			const current = next.uplinks.find(
				(uplink) => uplink.identity === natural.identity,
			);
			if (current && current.mark !== natural.mark) {
				affected.add(natural.mark);
				affected.add(current.mark);
			}
			if (
				base.claims.some(
					(claim) =>
						claim.mark === natural.mark && claim.identity !== natural.identity,
				)
			)
				affected.add(natural.mark);
		}
		for (const mark of intent?.affected ?? []) affected.add(mark);
		const claims: MarkClaim[] = [];
		for (const route of next.routes) {
			const old = base.claims.find((claim) => claim.mark === route.mark);
			const ifindex =
				this.#indices.get(route.ifname) ??
				(await this.#deps.linkIndex(route.ifname));
			const claim: MarkClaim = {
				identity: route.identity,
				ifname: route.ifname,
				ifindex,
				sourceAddress: route.sourceAddress,
				table: route.table,
				mark: route.mark,
				epoch: 0,
			};
			const legacyAdoption =
				base.seq === 0 &&
				matchesLegacy(this.#observed?.legacy ?? "", {
					...empty,
					claims: [claim],
				});
			claim.epoch = sameBinding(claim, old)
				? (old?.epoch ?? 0)
				: affected.has(route.mark) && !legacyAdoption
					? seq
					: 0;
			if (
				affected.has(route.mark) &&
				provisional.some((item) => item.mark === route.mark)
			)
				claim.epoch = seq;
			claims.push(claim);
		}
		let target: MarkImage = {
			seq,
			digest,
			claims,
			zones: [...next.clientZones],
			affected: [...affected].sort((a, b) => a - b),
		};
		if (intent) {
			const resumed: MarkImage = {
				...target,
				seq: intent.seq,
				claims: target.claims.map((claim) => ({
					...claim,
					epoch: claim.epoch === seq ? intent.seq : claim.epoch,
				})),
			};
			if (isDeepStrictEqual(resumed, intent)) target = resumed;
		}
		const unsettled = new Map(provisional.map((claim) => [claim.mark, claim]));
		if (intent && target.seq !== intent.seq) {
			for (const claim of intent.claims) {
				const old = base.claims.find((item) => item.mark === claim.mark);
				if (!sameBinding(claim, old) || claim.epoch !== old?.epoch)
					unsettled.set(claim.mark, claim);
			}
			for (const old of base.claims) {
				if (
					intent.affected.includes(old.mark) &&
					!intent.claims.some((item) => item.mark === old.mark)
				)
					unsettled.set(old.mark, old);
			}
		}
		const former = [...unsettled.values()];
		if (target.seq !== intent?.seq) {
			target = {
				...target,
				claims: target.claims.map((claim) =>
					affected.has(claim.mark) && unsettled.has(claim.mark)
						? { ...claim, epoch: target.seq }
						: claim,
				),
			};
		}
		const record: MarkJournal = {
			version: 1,
			base,
			intent: target,
			provisional: former,
		};
		await this.#deps.journal.save(record);
		this.#record = record;
		if (affected.size === 0) {
			await this.#deps.applyLegacy(previous, next);
		} else {
			await this.#applyCollision(base, target, former, next);
		}
		const committed: MarkJournal = {
			version: 1,
			base: target,
			provisional: [],
		};
		await this.#deps.journal.save(committed);
		this.#record = committed;
	}

	async #applyCollision(
		base: MarkImage,
		target: MarkImage,
		provisional: readonly MarkClaim[],
		next: PreparedSteeringState,
	): Promise<void> {
		const byMark = new Map(target.claims.map((claim) => [claim.mark, claim]));
		const prior = new Map(base.claims.map((claim) => [claim.mark, claim]));
		const retain = (claim: MarkClaim) => {
			const old = prior.get(claim.mark);
			return (
				old !== undefined &&
				sameBinding(claim, old) &&
				old.epoch === claim.epoch
			);
		};
		const retire = new Set<number>();
		for (const mark of target.affected) {
			const claim = byMark.get(mark);
			if (
				claim?.epoch === target.seq ||
				(claim === undefined &&
					(prior.has(mark) || provisional.some((old) => old.mark === mark)))
			)
				retire.add(mark);
		}
		const zones = [...base.zones, ...target.zones];
		// Install the egress fence before changing anything the old classifier can select.
		await this.#deps.guard({
			seq: target.seq,
			phase: "fenced",
			zones,
			claims: [
				...target.claims.filter(
					(claim) =>
						retain(claim) ||
						(!retire.has(claim.mark) &&
							!prior.has(claim.mark) &&
							claim.epoch === 0),
				),
				...base.claims.filter(
					(claim) =>
						!target.affected.includes(claim.mark) &&
						!target.claims.some(
							(item) => item.mark === claim.mark && retain(item),
						),
				),
			],
		});
		await this.#deps.armFence();
		for (const mark of (await this.#deps.inventory?.()) ?? []) {
			if (!byMark.has(mark)) retire.add(mark);
		}
		for (const mark of retire) {
			await this.#deps.flush(mark);
			await this.#deps.retire(mark);
			const old = prior.get(mark);
			if (old !== undefined) this.#deps.notifyRetired?.(old);
		}
		for (const route of next.routes) await this.#deps.ensure(route);
		for (const old of [...base.claims, ...provisional]) {
			if (!byMark.has(old.mark) && !retire.has(old.mark)) {
				await this.#deps.flush(old.mark);
				await this.#deps.retire(old.mark);
				retire.add(old.mark);
				if (prior.has(old.mark)) this.#deps.notifyRetired?.(old);
			}
		}
		await this.#deps.publish(
			buildShareRuleset(next, {
				seq: target.seq,
				phase: "committed",
				zones: target.zones,
				claims: target.claims,
			}),
			next.clientZones.length > 0,
		);
	}
}
