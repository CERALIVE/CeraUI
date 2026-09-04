// Auth status store using Svelte 5 runes with manual subscriber pattern
// (Cannot use $effect in subscribe - it only works during component initialization)
import type { LoginInput, LoginOutput } from "@ceraui/rpc/schemas";

import { rpc, rpcClient } from "$lib/rpc/client";

let authStatus = $state(false);

export type AuthAttempt =
	| { kind: "ok" }
	| { kind: "rejected" }
	| {
			kind: "unreachable";
			cause: "socket-not-ready" | "rpc-error" | "timeout";
	  };

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

function persistCredential(result: LoginOutput, persistentToken: boolean): void {
	if (!persistentToken) {
		localStorage.removeItem("auth");
	} else if (result.auth_token) {
		localStorage.setItem("auth", result.auth_token);
	}
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

async function authenticateInput(input: LoginInput): Promise<AuthAttempt> {
	if (!(await whenSocketReady())) {
		return { kind: "unreachable", cause: "socket-not-ready" };
	}
	let result: LoginOutput;
	try {
		result = await rpc.auth.login(input);
	} catch (error) {
		console.error("Failed to authenticate:", error);
		return {
			kind: "unreachable",
			cause:
				error instanceof Error && error.message.startsWith("Request timeout:")
					? "timeout"
					: "rpc-error",
		};
	}
	if (!result.success) {
		ingestAuth(result);
		return { kind: "rejected" };
	}
	// Token reauthentication succeeds without issuing a replacement. In that
	// case retain the existing token, just as on an unreachable attempt.
	persistCredential(result, input.persistent_token);
	ingestAuth(result);
	setAuthStatus(true);
	return { kind: "ok" };
}

export function authenticate(
	password: string,
	persistentToken: boolean,
): Promise<AuthAttempt> {
	return authenticateInput({ password, persistent_token: persistentToken });
}

export function authenticateWithToken(token: string): Promise<AuthAttempt> {
	return authenticateInput({ token, persistent_token: true });
}

export async function createPassword(password: string): Promise<void> {
	if (!(await whenSocketReady())) {
		throw new Error("Connection timeout");
	}
	const result = await rpc.auth.setPassword({ password });
	// The device revokes all remembered tokens on a successful password change.
	if (result.success) localStorage.removeItem("auth");
}

// Best-effort on purpose: the callers are recovery paths whose premise is that
// the stored token may already be dead, so the socket is unauthenticated and the
// device refuses. Clearing local storage is what the operator asked for either
// way, so a refusal must never block it.
export async function revokePersistentToken(token: string): Promise<void> {
	if (token.length === 0) return;
	try {
		if (!rpcClient.isConnected()) return;
		await rpc.auth.revokeToken({ token, scope: "token" });
	} catch (error) {
		console.warn("Failed to revoke the stored credential:", error);
	}
}
