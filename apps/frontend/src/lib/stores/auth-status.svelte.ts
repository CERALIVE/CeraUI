// Auth status store using Svelte 5 runes with manual subscriber pattern
// (Cannot use $effect in subscribe - it only works during component initialization)
import type {
	LoginInput,
	LoginOutput,
	SetPasswordInput,
} from "@ceraui/rpc/schemas";

import { rpc, rpcClient } from "$lib/rpc/client";
import { NotSentError, RpcError } from "$lib/rpc/rpc-error";
import {
	clearAuthenticatedLink,
	getLinkEpoch,
	noteAuthenticatedLink,
} from "$lib/rpc/session-epoch.svelte";

let authStatus = $state(false);
let sessionExpired = $state(false);
let interaction = new AbortController();

export function getSessionExpired(): boolean {
	return sessionExpired;
}

export function setSessionExpired(expired: boolean): void {
	sessionExpired = expired;
}

export type AuthAttempt =
	| { kind: "ok" }
	| { kind: "rejected" }
	| { kind: "cancelled" }
	| {
			kind: "unreachable";
			cause: "socket-not-ready" | "rpc-error" | "timeout";
	  };

// Last login/create-password RESULT. Mutated ONLY by `ingestAuth` — the single
// auth-message write path that replaces the old AuthStore._set race.
let authMessage = $state<LoginOutput | undefined>(undefined);

// Manual subscriber management
type Subscriber = (status: boolean) => void;
// biome-ignore lint/nursery/useSvelteReactiveClasses: Imperative subscriptions notify synchronously; tracking Set reads would subscribe effects to listener registration.
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
	if (!status) clearAuthenticatedLink();
	clearAuthInteraction();
	authStatus = status;
	notifySubscribers();
}

/** Retire local pending auth before notifying the interaction's field owner. */
export function clearAuthInteraction(): void {
	interaction.abort();
	interaction = new AbortController();
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

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", clearAuthInteraction);
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) clearAuthInteraction();
	});
}

export function getAuthMessage(): LoginOutput | undefined {
	return authMessage;
}

export function ingestAuth(message: LoginOutput | undefined): void {
	authMessage = message;
}

function persistCredential(
	result: LoginOutput,
	persistentToken: boolean,
): void {
	if (!persistentToken) {
		localStorage.removeItem("auth");
	} else if (result.auth_token) {
		localStorage.setItem("auth", result.auth_token);
	}
}

// rpcClient.call() rejects synchronously on a non-OPEN socket, so the mount-time
// token login must wait for the connection first (the boot connect is async).
function whenSocketReady(signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	if (rpcClient.isConnected()) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			signal.removeEventListener("abort", cancelled);
			resolve(ready);
		};
		const cancelled = () => finish(false);
		const timer = setTimeout(() => finish(false), 10_000);
		signal.addEventListener("abort", cancelled, { once: true });
		unsubscribe = rpcClient.onConnectionChange((state) => {
			if (state !== "connected" || settled) return;
			finish(true);
		});
	});
}

async function authenticateInput(
	input: LoginInput,
	cancelled?: AbortSignal,
): Promise<AuthAttempt> {
	const signal = AbortSignal.any([
		interaction.signal,
		...(cancelled ? [cancelled] : []),
	]);
	const clearPassword = () => {
		if (input.password !== undefined) input.password = "";
	};
	signal.addEventListener("abort", clearPassword, { once: true });
	const persistent = input.persistent_token;
	try {
		const ready = await whenSocketReady(signal);
		if (signal.aborted) return { kind: "cancelled" };
		if (!ready) {
			return { kind: "unreachable", cause: "socket-not-ready" };
		}
		let result: LoginOutput;
		const link = getLinkEpoch();
		try {
			const reply = rpc.auth.login(input);
			// The client serializes synchronously; the pending reply needs no plaintext.
			clearPassword();
			result = await reply;
		} catch (error) {
			if (signal.aborted) return { kind: "cancelled" };
			console.error("Failed to authenticate:", error);
			return {
				kind: "unreachable",
				cause:
					error instanceof Error && error.message.startsWith("Request timeout:")
						? "timeout"
						: "rpc-error",
			};
		}
		if (signal.aborted) return { kind: "cancelled" };
		if (link !== getLinkEpoch() || !rpcClient.isConnected()) {
			return { kind: "unreachable", cause: "rpc-error" };
		}
		if (!result.success) {
			ingestAuth(result);
			return { kind: "rejected" };
		}
		// Token reauthentication succeeds without issuing a replacement. In that
		// case retain the existing token, just as on an unreachable attempt.
		persistCredential(result, persistent);
		ingestAuth(result);
		setSessionExpired(false);
		noteAuthenticatedLink(link);
		setAuthStatus(true);
		return { kind: "ok" };
	} finally {
		clearPassword();
		signal.removeEventListener("abort", clearPassword);
	}
}

export function authenticate(
	password: string,
	persistentToken: boolean,
	signal?: AbortSignal,
): Promise<AuthAttempt> {
	return authenticateInput(
		{ password, persistent_token: persistentToken },
		signal,
	);
}

export function authenticateWithToken(token: string): Promise<AuthAttempt> {
	return authenticateInput({ token, persistent_token: true });
}

export function createPassword(
	password: string,
	cancelled?: AbortSignal,
): Promise<boolean> {
	return createPasswordInput({ password }, cancelled);
}

async function createPasswordInput(
	input: SetPasswordInput,
	cancelled?: AbortSignal,
): Promise<boolean> {
	const signal = AbortSignal.any([
		interaction.signal,
		...(cancelled ? [cancelled] : []),
	]);
	const clearPassword = () => {
		input.password = "";
	};
	signal.addEventListener("abort", clearPassword, { once: true });
	try {
		const ready = await whenSocketReady(signal);
		if (signal.aborted) return false;
		if (!ready) return false;
		let result: { success: boolean };
		try {
			const reply = rpc.auth.setPassword(input);
			// Do not retain the setup secret across the device reply.
			clearPassword();
			result = await reply;
		} catch (error) {
			if (signal.aborted) return false;
			if (
				error instanceof RpcError ||
				error instanceof NotSentError ||
				(error instanceof Error &&
					(error.name === "ConnectionResetError" ||
						(error.name === "Error" &&
							error.message.startsWith("Request timeout:"))))
			) {
				return false;
			}
			throw error;
		}
		if (signal.aborted) return false;
		// The device revokes all remembered tokens on a successful password change.
		if (result.success) localStorage.removeItem("auth");
		return result.success;
	} finally {
		clearPassword();
		signal.removeEventListener("abort", clearPassword);
	}
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
