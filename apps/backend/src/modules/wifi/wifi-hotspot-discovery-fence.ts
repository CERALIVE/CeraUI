// Deletion evidence only fences reads that were already in flight.
const deletions = new Map<string, number>();
const reads = new Set<{ readonly epoch: number }>();
let epoch = 0;

export function recordHotspotProfileDeletion(uuid: string): void {
	if (reads.size > 0) deletions.set(uuid, ++epoch);
}

export function wasHotspotConnDeletedSince(
	uuid: string,
	since: number,
): boolean {
	return (deletions.get(uuid) ?? 0) > since;
}

export function trackHotspotProfileRead() {
	const read = { epoch };
	reads.add(read);
	return {
		epoch,
		[Symbol.dispose]() {
			reads.delete(read);
			let oldest = epoch;
			for (const pending of reads) oldest = Math.min(oldest, pending.epoch);
			for (const [uuid, deleted] of deletions) {
				if (deleted <= oldest) deletions.delete(uuid);
			}
		},
	};
}
