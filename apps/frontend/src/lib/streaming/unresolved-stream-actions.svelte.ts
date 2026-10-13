/**
 * The operator's stream actions whose outcome the device has not settled yet
 * (FIX-16-FRONT3, early oracle R1/R2 and the NavigationRenderer row).
 *
 * Singletons on purpose. NavigationRenderer replaces the destination component,
 * so a record kept in LiveView's own state was lost on navigation while the
 * optimism and the async operation it qualifies are app-wide. Each record keeps
 * the lifecycle-delivery mark (`session-epoch`) taken when it was made: only a
 * lifecycle DELIVERED after that mark, over the link that is current now, can
 * settle it. A restored session, a retained snapshot, a failed hydrate, a
 * transport failure and a lapsed TTL settle nothing.
 */
import {
	getLifecycleDelivery,
	lifecycleDeliveredSince,
} from "$lib/rpc/session-epoch.svelte";

interface LostStartReply {
	readonly generation: number;
	readonly mark: number;
}

let lostStart = $state.raw<LostStartReply | undefined>(undefined);
let stopClaim = $state.raw<{ readonly mark: number } | undefined>(undefined);

/** Attempt `generation`'s start reply was lost to a connection reset. */
export function noteLostStartReply(generation: number): void {
	lostStart = { generation, mark: getLifecycleDelivery().seq };
}

/** A lifecycle reached this page over the current link since `generation`'s reply was lost. */
export function lifecycleSinceLostStartReply(generation: number): boolean {
	const lost = lostStart;
	return (
		lost !== undefined &&
		lost.generation === generation &&
		lifecycleDeliveredSince(lost.mark)
	);
}

/**
 * The operator pressed the unconfirmed-state Stop. Its outcome stays UNKNOWN,
 * and its recovery surface stays on screen, until `settleOperatorStop()`.
 */
export function claimOperatorStop(): void {
	stopClaim = { mark: getLifecycleDelivery().seq };
}

export function operatorStopUnresolved(): boolean {
	return stopClaim !== undefined;
}

/** The held lifecycle was delivered after the claim, over the current link. */
export function lifecycleSinceStopClaim(): boolean {
	const claim = stopClaim;
	return claim !== undefined && lifecycleDeliveredSince(claim.mark);
}

/** Only positive settlement: the device's idle commit, or an acknowledged Stop. */
export function settleOperatorStop(): void {
	stopClaim = undefined;
}

/** Test/teardown seam, called with the optimism store's own teardown. */
export function resetUnresolvedStreamActions(): void {
	lostStart = undefined;
	stopClaim = undefined;
}
