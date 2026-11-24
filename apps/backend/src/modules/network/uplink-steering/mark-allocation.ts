import { SteeringUnavailableError } from "./contracts.ts";
import { markForSlot } from "./mark-layout.ts";

export function assignSteeringMarks(
	candidates: readonly { readonly identity: string; readonly mark: number }[],
	incumbents: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
	const ordered = [...candidates].sort((a, b) =>
		a.identity < b.identity ? -1 : a.identity === b.identity ? 0 : 1,
	);
	const assigned = new Map<string, number>();
	const used = new Set<number>();
	const identities = new Set<string>();
	for (const { identity } of ordered) {
		if (identities.has(identity)) {
			throw new SteeringUnavailableError(
				"mark_collision",
				"two interfaces have the same steering identity",
			);
		}
		identities.add(identity);
		const incumbent = incumbents.get(identity);
		if (incumbent === undefined) continue;
		assigned.set(identity, incumbent);
		used.add(incumbent);
	}
	// Reserve every still-free natural home before probing for the losers.
	for (const { identity, mark } of ordered) {
		if (assigned.has(identity) || used.has(mark)) continue;
		assigned.set(identity, mark);
		used.add(mark);
	}
	for (const { identity, mark } of ordered) {
		if (assigned.has(identity)) continue;
		const natural = (mark >>> 8) & 0xffff;
		let slot = natural;
		do {
			slot = slot === 0xffff ? 1 : slot + 1;
			if (slot === natural) {
				throw new SteeringUnavailableError(
					"mark_collision",
					"steering marks exhausted",
				);
			}
		} while (used.has(markForSlot(slot)));
		const assignedMark = markForSlot(slot);
		assigned.set(identity, assignedMark);
		used.add(assignedMark);
	}
	return assigned;
}
