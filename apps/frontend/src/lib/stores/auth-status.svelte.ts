// Auth status store using Svelte 5 runes with manual subscriber pattern
// (Cannot use $effect in subscribe - it only works during component initialization)
import type { LoginOutput } from "@ceraui/rpc/schemas";

import { rpc, rpcClient } from "$lib/rpc/client";

let authStatus = $state(false);

// Last login/create-password RESULT. Mutated ONLY by `ingestAuth` — the single
// auth-message write path that replaces the old AuthStore._set race.
let authMessage = $state<LoginOutput | undefined>(undefined);

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

export function getAuthMessage(): LoginOutput | undefined {
	return authMessage;
}

export function ingestAuth(message: LoginOutput | undefined): void {
	authMessage = message;
}

// rpcClient.call() rejects synchronously on a non-OPEN socket, so the mount-time
// token login must wait for the connection first (the boot connect is async).
function whenSocketReady(maxWaitMs = 10_000): Promise<boolean> {
	if (rpcClient.isConnected()) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribe?.();
			resolve(false);
		}, maxWaitMs);
		unsubscribe = rpcClient.onConnectionChange((state) => {
			if (state !== "connected" || settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			resolve(true);
		});
	});
}

export async function authenticate(
	password: string,
	persistentToken: boolean,
): Promise<void> {
	if (!(await whenSocketReady())) {
		ingestAuth({ success: false });
		return;
	}
	try {
		ingestAuth(
			await rpc.auth.login({ password, persistent_token: persistentToken }),
		);
	} catch (error) {
		console.error("Failed to authenticate:", error);
		ingestAuth({ success: false });
	}
}

export async function createPassword(password: string): Promise<void> {
	if (!(await whenSocketReady())) {
		throw new Error("Connection timeout");
	}
	await rpc.auth.setPassword({ password });
}
