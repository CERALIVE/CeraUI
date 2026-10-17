/**
 * The operator's stream actions whose outcome the device has not settled yet
 * (FIX-16-FRONT3, early oracle R1/R2 and the NavigationRenderer row).
 *
 * Singletons on purpose. NavigationRenderer replaces the destination component,
 * so a record kept in LiveView's own state was lost on navigation while the
 * optimism and the async operation it qualifies are app-wide. Each record keeps
 * the evidence-clock mark (`session-epoch`) taken when it was made: only a
 * push RECEIVED, or pull DISPATCHED, after that mark on the current link can
 * settle it. A restored session, a retained snapshot, a failed hydrate, a
 * transport failure and a lapsed TTL settle nothing.
 *
 * A singleton is replaced by the next press, while the earlier press's reply can
 * still be on the wire. So every Stop claim carries an owner token, and a reply
 * settles only the claim it was made for (FIX-16-F4, C4-2).
 */
import type { StatusResponse } from "@ceraui/rpc/schemas";
import {
	evidenceClock,
	getLinkEpoch,
	lifecycleDeliveredSince,
	markStreamIntent,
	type Receipt,
} from "$lib/rpc/session-epoch.svelte";

interface LostStartReply {
	readonly generation: number;
	readonly mark: number;
	readonly recoveryUnknown?: boolean;
}

interface StopClaim {
	/** The token `claimOperatorStop()` returned for this press. */
	readonly owner: number;
	/**
	 * The evidence clock when the operator pressed Stop: every status frame
	 * RECEIVED before the press is at or below it, consumed or not (FIX-16-F5).
	 */
	readonly mark: number;
	/**
	 * No positive settlement yet. An acknowledged Stop closes the claim but keeps
	 * its mark, so the same press's pending operation can still be confirmed by
	 * the idle commit that follows.
	 */
	readonly open: boolean;
}

let lostStart = $state.raw<LostStartReply | undefined>(undefined);
let stopClaim = $state.raw<StopClaim | undefined>(undefined);
let stopOwners = 0;
let startGeneration = 0;

export function ownStartAttempt(generation: number): void {
	startGeneration = generation;
	lostStart = undefined;
}

/** The bounded reader exhausted evidence, not the originating attempt's ownership. */
export function noteStartRecoveryUnknown(generation: number): void {
	if (generation !== startGeneration) return;
	lostStart = { generation, mark: markStreamIntent(), recoveryUnknown: true };
}

export function startRecoveryUnknown(generation: number): boolean {
	return (
		lostStart?.generation === generation && lostStart.recoveryUnknown === true
	);
}

export function clearStartRecoveryUnknown(generation: number): void {
	if (generation === startGeneration && startRecoveryUnknown(generation))
		lostStart = undefined;
}

/** Called with selected fields only: a superseded stream group supplies no facts. */
export function settleStartRecoveryEvidence(
	status: Pick<Partial<StatusResponse>, "is_streaming" | "stream_lifecycle">,
	receipt: Receipt,
): number | undefined {
	const lost = lostStart;
	if (
		lost?.recoveryUnknown !== true ||
		lost.generation !== startGeneration ||
		receipt.link !== getLinkEpoch() ||
		(receipt.dispatch?.at ?? receipt.at) <= lost.mark
	)
		return undefined;
	const settled =
		status.stream_lifecycle === "idle" ||
		status.stream_lifecycle === "streaming" ||
		(status.stream_lifecycle === undefined &&
			typeof status.is_streaming === "boolean");
	if (!settled) return undefined;
	lostStart = undefined;
	return lost.generation;
}

/** Attempt `generation`'s start reply was lost to a connection reset. */
export function noteLostStartReply(generation: number): void {
	if (generation !== startGeneration || startRecoveryUnknown(generation))
		return;
	lostStart = { generation, mark: markStreamIntent() };
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
 * and its recovery surface stays on screen, until the device settles it.
 * Returns the owner token that press's reply must present to settle it.
 */
export function claimOperatorStop(): number {
	markStreamIntent();
	stopOwners += 1;
	stopClaim = {
		owner: stopOwners,
		mark: evidenceClock(),
		open: true,
	};
	return stopOwners;
}

export function operatorStopUnresolved(): boolean {
	return stopClaim?.open === true;
}

/** The owner of the latest Stop claim, settled or not. */
export function latestStopOwner(): number | undefined {
	return stopClaim?.owner;
}

/**
 * The held lifecycle was delivered after the LATEST Stop press, over the
 * current link. The only evidence that may confirm that press's operation.
 */
export function lifecycleSinceStopClaim(): boolean {
	const claim = stopClaim;
	return claim !== undefined && lifecycleDeliveredSince(claim.mark);
}

/**
 * Positive settlement of `owner`'s claim: the device's idle commit after it, or
 * its own acknowledged Stop. A superseded owner settles nothing.
 */
export function settleOperatorStop(owner: number): boolean {
	const claim = stopClaim;
	if (claim?.owner !== owner || !claim.open) return false;
	stopClaim = { ...claim, open: false };
	return true;
}

/** Test/teardown seam, called with the optimism store's own teardown. */
export function resetUnresolvedStreamActions(): void {
	lostStart = undefined;
	stopClaim = undefined;
	startGeneration = 0;
}
