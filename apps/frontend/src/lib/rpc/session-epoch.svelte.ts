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
