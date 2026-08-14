/**
 * Shared constants for the `persist-isolation-{a,b}.test.ts` PAIR. The two spec
 * files must be genuinely separate files — the contract they prove is that one
 * spec file's `$persist` write is invisible to another — so anything they share
 * lives here rather than in either of them.
 */
export const BLEED_SETTLE_MS = 250;

export function markerKey(spec: string): string {
	return `persist-isolation-marker-${spec}`;
}

export function settle(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
