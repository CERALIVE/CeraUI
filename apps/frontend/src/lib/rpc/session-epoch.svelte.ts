/**
 * How many times this page has RESTORED its authenticated session after a
 * dropped link (`reauthenticateAndHydrate` answered "hydrated").
 *
 * The subscription layer re-hydrates PUSHED state itself. A surface that holds
 * PULLED device state (the Updates dialog's details) re-reads it whenever this
 * count moves: a pushed field that is unchanged after an outage says nothing
 * about what the device did while the browser was away. Its own module so a
 * consumer does not depend on the subscription layer to read it.
 */
let restored = $state(0);

export function getRestoredSessions(): number {
	return restored;
}

export function noteSessionRestored(): void {
	restored += 1;
}

/**
 * How many times the link has DROPPED: a change marks a different socket, and
 * after a backend restart a different process. Bumped synchronously on the
 * edge, before anything can be read over the next socket (round-3 review C,
 * C3-2). Reactive, so every rendered conclusion that names a link is withdrawn
 * at the drop itself, not at the next unrelated re-render (early oracle F2).
 */
let links = $state(0);
let linkUp = false;

export function getLinkEpoch(): number {
	return links;
}

export function noteLinkState(state: string): void {
	const up = state === "connected";
	if (linkUp && !up) links += 1;
	linkUp = up;
}

/**
 * When a status frame REACHED this page: the link it arrived on and a tick of
 * one monotonic evidence clock (FIX-16-F5, F4-R1). Taken at receipt (a push in
 * the socket's message handler, a pulled answer in the continuation of its own
 * request) and carried to ingestion. Receipt is browser arrival, NOT device
 * computation time. A pull also names the request's earlier dispatch.
 */
export interface Receipt {
	readonly link: number;
	readonly at: number;
	readonly dispatch?: RequestDispatch;
}

export interface RequestDispatch {
	readonly link: number;
	readonly at: number;
}

let clock = 0;
let newestStreamFrame = 0;
let newestIntent = 0;

export function dispatchEvidence(): RequestDispatch {
	clock += 1;
	return { link: links, at: clock };
}

/** An intent supersedes every read already on the wire. */
export function markStreamIntent(): number {
	clock += 1;
	newestIntent = clock;
	return clock;
}

export function receiveEvidence(dispatch?: RequestDispatch): Receipt {
	clock += 1;
	return { link: links, at: clock, dispatch };
}

/** Page-local ordering horizon: dispatches, receipts and stream intents. */
export function evidenceClock(): number {
	return clock;
}

/**
 * Receipt order fences buffered frames; dispatch order also fences pending
 * pulls against intervening intents/STREAM-FACT observations. Unrelated fields
 * have independent ordering at ingestion. Neither dates computation.
 */
export function statusFrameIsCurrent(receipt: Receipt): boolean {
	return (
		receipt.link === links &&
		receipt.at >= newestStreamFrame &&
		(receipt.dispatch === undefined ||
			(receipt.dispatch.link === links &&
				receipt.dispatch.at > newestIntent &&
				receipt.dispatch.at >= newestStreamFrame))
	);
}

export function admitStatusFrame(receipt: Receipt): boolean {
	if (!statusFrameIsCurrent(receipt)) return false;
	newestStreamFrame = receipt.at;
	return true;
}

/**
 * When the held `stream_lifecycle` was DELIVERED: the receipt of the frame that
 * carried it (FIX-16-FRONT3, early oracle R1; `seq` is the receipt's clock
 * tick). Stamped only by a status frame that carries the field, or by a full
 * snapshot that establishes its absence. A restored session is not this
 * evidence (its hydrate can fail and still count as restored), and neither is a
 * partial push without the field, because the status merge keeps the old value.
 */
export interface LifecycleDelivery {
	readonly link: number;
	readonly seq: number;
	readonly dispatchedAt?: number;
}

let lifecycleDelivery = $state.raw<LifecycleDelivery>({ link: -1, seq: 0 });

export function getLifecycleDelivery(): LifecycleDelivery {
	return lifecycleDelivery;
}

export function noteLifecycleDelivered(
	receipt: Receipt = receiveEvidence(),
): void {
	lifecycleDelivery = {
		link: receipt.link,
		seq: receipt.at,
		dispatchedAt: receipt.dispatch?.at,
	};
}

/** Post-horizon current-link evidence: pull dispatch, or push receipt. */
export function lifecycleDeliveredSince(mark: number): boolean {
	return (
		(lifecycleDelivery.dispatchedAt ?? lifecycleDelivery.seq) > mark &&
		lifecycleDelivery.link === links
	);
}
