// Auth status store using Svelte 5 runes with manual subscriber pattern
// (Cannot use $effect in subscribe - it only works during component initialization)

let authStatus = $state(false);

// Manual subscriber management
type Subscriber = (status: boolean) => void;
const subscribers = new Set<Subscriber>();

function notifySubscribers(): void {
	for (const callback of subscribers) {
		callback(authStatus);
	}
}

export function getAuthStatus(): boolean {
	return authStatus;
}

export function setAuthStatus(status: boolean): void {
	authStatus = status;
	notifySubscribers();
}

// Subscribe pattern compatible with Svelte store contract
export function subscribeAuthStatus(callback: Subscriber): () => void {
	subscribers.add(callback);
	// Call immediately with current value (standard store behavior)
	callback(authStatus);
	// Return unsubscribe function
	return () => {
		subscribers.delete(callback);
	};
}

// Legacy-compatible store-like object for easier migration
export const authStatusStore = {
	get value() {
		return authStatus;
	},
	set: setAuthStatus,
	subscribe: subscribeAuthStatus,
};
