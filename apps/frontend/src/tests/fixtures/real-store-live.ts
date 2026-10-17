/**
 * The REAL status carrier for LiveView tests (FIX-16-FRONT3): the subscription
 * store's own message and connection handlers, its reconnect re-authentication
 * and hydrate, and the session epoch, driven over a scripted transport.
 *
 * The C3 harness replaced the lifecycle getter and the restoration driver with
 * stand-ins, which is how a failed hydrate and a full snapshot without a
 * lifecycle passed 220 tests (early oracle R1/R4). Here a status reaches the
 * store only as the device delivers it: a pushed frame, or the reply to the
 * hydrate's `status.getStatus`.
 */
import { waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { expect } from "vitest";

import { getRestoredSessions } from "$lib/rpc/session-epoch.svelte";

export interface ScriptedTransport {
	message: ((type: string, data: unknown, seq?: number) => void) | undefined;
	connection: ((state: string) => void) | undefined;
	/** What `wasAuthenticated()` answers: only a re-login re-hydrates. */
	authenticated: boolean;
}

/** The `rpcClient` surface `initSubscriptions()` registers its handlers on. */
export function rpcClientMock(transport: ScriptedTransport) {
	return {
		onMessage: (fn: ScriptedTransport["message"]) => {
			transport.message = fn;
		},
		onConnectionChange: (fn: ScriptedTransport["connection"]) => {
			transport.connection = fn;
			return () => undefined;
		},
		connect: () => undefined,
		isConnected: () => true,
		getSocket: () => null,
		sendLegacy: () => undefined,
	};
}

/**
 * The start-ready device of `real-cockpit-harness`, with the STATUS carrier
 * left real: `getStatus`, `getIsStreaming` and `ingestPulledStatus` are the
 * subscription module's own.
 */
export async function deviceGettersMock<T extends object>(
	original: T,
): Promise<T> {
	const { subscriptionsMock } = await import("./real-cockpit-harness");
	const real = original as Record<string, unknown>;
	return {
		...subscriptionsMock(original, () => undefined),
		getIsStreaming: real.getIsStreaming,
		getStatus: real.getStatus,
		ingestPulledStatus: real.ingestPulledStatus,
	} as T;
}

/** A status frame pushed by the device over the live socket. */
export function push(
	transport: ScriptedTransport,
	frame: Record<string, unknown>,
): void {
	transport.message?.("status", frame);
	flushSync();
}

/** The page's first link comes up; nothing re-authenticates on it. */
export function firstLink(transport: ScriptedTransport): void {
	transport.authenticated = false;
	transport.connection?.("connected");
	transport.authenticated = true;
	flushSync();
}

/** The socket closed. `RPCClient` rejects the in-flight requests, then reports the edge. */
export function dropLink(transport: ScriptedTransport): void {
	transport.connection?.("disconnected");
	flushSync();
}

/**
 * A new socket opens and re-authentication succeeds (the session counts as
 * restored). `hydrate` scripts the safety hydrate's `status.getStatus` reply.
 */
export async function restoreLink(
	transport: ScriptedTransport,
	getStatus: {
		mockRejectedValueOnce(e: unknown): unknown;
		mockResolvedValueOnce(v: unknown): unknown;
	},
	hydrate: { fails: true } | { status: Record<string, unknown> },
): Promise<void> {
	if ("fails" in hydrate)
		getStatus.mockRejectedValueOnce(new Error("INTERNAL_ERROR"));
	else getStatus.mockResolvedValueOnce(hydrate.status);
	const before = getRestoredSessions();
	transport.connection?.("connected");
	await waitFor(() => expect(getRestoredSessions()).toBe(before + 1));
	flushSync();
}
