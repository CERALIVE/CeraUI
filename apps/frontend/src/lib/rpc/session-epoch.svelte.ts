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
