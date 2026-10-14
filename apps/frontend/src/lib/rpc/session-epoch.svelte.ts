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
 * request) and carried to ingestion, so an answer consumed late still names the
 * moment the device answered, never the moment a consumer got to it.
 */
export interface Receipt {
	readonly link: number;
	readonly at: number;
}

let clock = 0;
let newestStatusFrame = 0;

export function receiveEvidence(): Receipt {
	clock += 1;
	return { link: links, at: clock };
}

/** The newest receipt so far, consumed or not: a claim's "after this moment". */
export function evidenceClock(): number {
	return clock;
}

/**
 * Admit a status frame unless one received AFTER it was already applied: the
 * newer frame wins, so a late older snapshot never regresses it.
 */
export function admitStatusFrame(receipt: Receipt): boolean {
	if (receipt.at < newestStatusFrame) return false;
	newestStatusFrame = receipt.at;
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
}

let lifecycleDelivery = $state.raw<LifecycleDelivery>({ link: -1, seq: 0 });

export function getLifecycleDelivery(): LifecycleDelivery {
	return lifecycleDelivery;
}

export function noteLifecycleDelivered(
	receipt: Receipt = receiveEvidence(),
): void {
	lifecycleDelivery = { link: receipt.link, seq: receipt.at };
}

/** A lifecycle delivered after `mark` (a `seq`) over the link that is current now. */
export function lifecycleDeliveredSince(mark: number): boolean {
	return lifecycleDelivery.seq > mark && lifecycleDelivery.link === links;
}
