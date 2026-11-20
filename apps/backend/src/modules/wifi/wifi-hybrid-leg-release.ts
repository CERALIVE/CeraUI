import type { HotspotActivationDeps } from "./wifi-hotspot-types.ts";

export type HybridLegAllocation = {
	readonly ifname: string;
	readonly created: boolean;
};

/**
 * The one hand-back of a Start's AP leg after a rollback. With its allocator
 * receipt, the policy release restores a borrowed leg's autoconnect only while
 * that selection is still the Start's own and the leg is idle. A leg this Start
 * created is deleted only when no created profile cleanup owns that deletion.
 */
export async function releaseHybridLeg(
	allocation: HybridLegAllocation,
	deps: Pick<
		HotspotActivationDeps,
		"releaseConcurrentInterface" | "rollbackConcurrentInterface"
	>,
	options: { readonly receipt: boolean; readonly deleteCreated: boolean },
): Promise<void> {
	if (options.receipt)
		await deps.releaseConcurrentInterface?.(allocation.ifname, allocation);
	else await deps.releaseConcurrentInterface?.(allocation.ifname);
	if (
		options.deleteCreated &&
		allocation.created &&
		deps.rollbackConcurrentInterface
	)
		await deps.rollbackConcurrentInterface(allocation);
}
