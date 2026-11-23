/**
 * Which socket the RPC client is on, advanced every time a new one opens. A reply
 * can arrive only on the socket its request was sent on, so once the epoch moves
 * on, no earlier request can still be answered.
 */
let epoch = $state(0);

export function socketEpoch(): number {
	return epoch;
}

export function nextSocketEpoch(): void {
	epoch += 1;
}
