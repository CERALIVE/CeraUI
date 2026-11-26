// A start refused by an unconfirmed modem change sends the operator to Network;
// the Cellular section takes the request and brings the notice into view.
let requested = false;

export function requestMutationBlockReveal(): void {
	requested = true;
}

export function takeMutationBlockReveal(): boolean {
	const taken = requested;
	requested = false;
	return taken;
}
