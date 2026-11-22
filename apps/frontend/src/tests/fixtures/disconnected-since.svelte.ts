// A settable, reactive stand-in for the connection store's drop stamp.
let since = $state<number | null>(null);

export function getDisconnectedSince(): number | null {
	return since;
}

export function setDisconnectedSince(next: number | null): void {
	since = next;
}
