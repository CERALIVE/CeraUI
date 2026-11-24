import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PreparedSteeringState, UplinkRoutePlan } from "./applier.ts";
import { SteeringUnavailableError, type SteeringUplink } from "./contracts.ts";
import type { MarkAdmission } from "./mark-admission.ts";
import type { MarkClaim, MarkImage, MarkJournal } from "./mark-journal.ts";
import { provenByKernel, sameBinding } from "./mark-ownership.ts";
import { buildShareRuleset } from "./ruleset.ts";

export function affectedMarks(
	record: MarkJournal,
	natural: readonly SteeringUplink[],
	assigned: ReadonlyMap<string, number>,
): Set<number> {
	const affected = new Set([
		...record.base.affected,
		...(record.intent?.affected ?? []),
	]);
	for (const { identity, mark } of natural) {
		const current = assigned.get(identity);
		if (current !== undefined && current !== mark) {
			affected.add(mark);
			affected.add(current);
		}
		if (
			record.base.claims.some(
				(claim) => claim.mark === mark && claim.identity !== identity,
			)
		)
			affected.add(mark);
	}
	return affected;
}

export function steeringDigest(next: PreparedSteeringState): string {
	return createHash("sha256").update(JSON.stringify(next)).digest("hex");
}

export async function planMarkIntent(
	record: MarkJournal,
	next: PreparedSteeringState,
	digest: string,
	affected: ReadonlySet<number>,
	legacy: string,
	linkIndex: (ifname: string) => Promise<number>,
): Promise<MarkImage & { readonly former: readonly MarkClaim[] }> {
	const { base, intent, provisional } = record;
	const seq = (intent?.seq ?? base.seq) + 1;
	if (seq > 0xffffffff)
		throw new SteeringUnavailableError(
			"mark_collision",
			"steering mark journal sequence exhausted",
		);
	const claims: MarkClaim[] = [];
	for (const route of next.routes) {
		const old = base.claims.find((claim) => claim.mark === route.mark);
		const claim: MarkClaim = {
			identity: route.identity,
			ifname: route.ifname,
			ifindex: await linkIndex(route.ifname),
			sourceAddress: route.sourceAddress,
			table: route.table,
			mark: route.mark,
			epoch: 0,
		};
		const legacyAdoption = provenByKernel(legacy, base.claims, claim);
		claim.epoch = sameBinding(base, claim, old)
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
			if (!sameBinding(base, claim, old) || claim.epoch !== old?.epoch)
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
	return { ...target, former: [...unsettled.values()] };
}

export interface MarkTransitionEffects {
	readonly armFence: () => Promise<void>;
	readonly guard: (admission: MarkAdmission) => Promise<void>;
	readonly retire: (mark: number) => Promise<void>;
	readonly inventory?: () => Promise<ReadonlySet<number>>;
	readonly ensure: (route: UplinkRoutePlan) => Promise<unknown>;
	readonly flush: (mark: number) => Promise<void>;
	readonly publish: (ruleset: string, active: boolean) => Promise<void>;
	readonly notifyRetired?: (claim: MarkClaim) => void;
}

export async function applyMarkTransition(
	deps: MarkTransitionEffects,
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
			sameBinding(base, claim, old) &&
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
	// Fence the old classifier before mutating any route it can currently select.
	await deps.guard({
		seq: target.seq,
		phase: "fenced",
		zones: [...base.zones, ...target.zones],
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
		affected: target.affected,
	});
	await deps.armFence();
	for (const mark of (await deps.inventory?.()) ?? []) {
		if (!byMark.has(mark)) retire.add(mark);
	}
	for (const mark of retire) {
		await deps.flush(mark);
		await deps.retire(mark);
		const old = prior.get(mark);
		if (old !== undefined) deps.notifyRetired?.(old);
	}
	for (const route of next.routes) await deps.ensure(route);
	for (const old of [...base.claims, ...provisional]) {
		if (!byMark.has(old.mark) && !retire.has(old.mark)) {
			await deps.flush(old.mark);
			await deps.retire(old.mark);
			retire.add(old.mark);
			if (prior.has(old.mark)) deps.notifyRetired?.(old);
		}
	}
	await deps.publish(
		buildShareRuleset(next, {
			seq: target.seq,
			phase: "committed",
			zones: target.zones,
			claims: target.claims,
			affected: target.affected,
		}),
		next.clientZones.length > 0,
	);
}
