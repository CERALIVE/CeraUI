/*
 * T2 — dev-only reboot disconnect simulation.
 *
 * On a real device, `system.reboot`/`system.poweroff` drop every socket because
 * the host goes down. In dev the spawn is gated off (T1), so the frontend's
 * DisconnectedBanner reconnect UX was never exercisable. `simulateDevReboot()`
 * reproduces the real-reboot effect by closing the authenticated client sockets
 * — but ONLY in dev.
 *
 * Two guarantees pinned here:
 *   (a) dev  → closes exactly the authenticated sockets, leaves unauthed alone.
 *   (b) prod → early-returns and closes NOTHING (prod-absence proof). The helper
 *       must be unreachable as a teardown when !isDevelopment().
 *
 * The teardown is DEFERRED to the next macrotask (real-device parity: the
 * caller's in-flight reply must flush before the socket drops — Bun discards a
 * send() issued after close()), so each test flushes a macrotask before
 * asserting. The helper only calls `ws.close()`; it never deauthenticates or
 * touches the auth_tokens store, so a closed client re-authenticates normally
 * on reconnect.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	addClient,
	getAuthenticatedClients,
	removeClient,
	simulateDevReboot,
} from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

/** A fake socket that records how many times it was asked to close. */
function makeClient(authed: boolean): {
	ws: AppWebSocket;
	closeCount: () => number;
} {
	let closed = 0;
	const ws = {
		data: { isAuthenticated: authed, lastActive: 0 },
		send: () => {},
		close: () => {
			closed++;
		},
	} as unknown as AppWebSocket;
	return { ws, closeCount: () => closed };
}

// The `clients` registry in events.ts is module-global; track every client we
// add so afterEach can drain it and no test leaks a socket into the next.
let added: AppWebSocket[] = [];
function track(ws: AppWebSocket): AppWebSocket {
	addClient(ws);
	added.push(ws);
	return ws;
}

/** Drain one macrotask so the deferred `setTimeout(close, 0)` teardown runs. */
function flushMacrotask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

let savedNodeEnv: string | undefined;
let savedMockMode: string | undefined;

beforeEach(() => {
	savedNodeEnv = process.env.NODE_ENV;
	savedMockMode = process.env.MOCK_MODE;
});

afterEach(() => {
	for (const ws of added) removeClient(ws);
	added = [];
	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	restore("NODE_ENV", savedNodeEnv);
	restore("MOCK_MODE", savedMockMode);
});

describe("simulateDevReboot — dev path", () => {
	test("NODE_ENV=development: closes every authenticated socket exactly once", async () => {
		process.env.NODE_ENV = "development";
		delete process.env.MOCK_MODE;

		const a = makeClient(true);
		const b = makeClient(true);
		track(a.ws);
		track(b.ws);

		simulateDevReboot();
		await flushMacrotask();

		expect(a.closeCount()).toBe(1);
		expect(b.closeCount()).toBe(1);
	});

	test("MOCK_MODE=true alone also drives the disconnect", async () => {
		delete process.env.NODE_ENV;
		process.env.MOCK_MODE = "true";

		const a = makeClient(true);
		track(a.ws);

		simulateDevReboot();
		await flushMacrotask();

		expect(a.closeCount()).toBe(1);
	});

	test("leaves UNauthenticated sockets untouched (only authed clients reboot)", async () => {
		process.env.NODE_ENV = "development";
		delete process.env.MOCK_MODE;

		const authed = makeClient(true);
		const anon = makeClient(false);
		track(authed.ws);
		track(anon.ws);

		simulateDevReboot();
		await flushMacrotask();

		expect(authed.closeCount()).toBe(1);
		expect(anon.closeCount()).toBe(0);
	});

	test("defers teardown — nothing closes synchronously (in-flight reply flushes first)", async () => {
		process.env.NODE_ENV = "development";
		delete process.env.MOCK_MODE;

		const a = makeClient(true);
		track(a.ws);

		simulateDevReboot();
		expect(a.closeCount()).toBe(0); // still open: the RPC reply gets sent first

		await flushMacrotask();
		expect(a.closeCount()).toBe(1); // then the socket drops
	});
});

describe("simulateDevReboot — production isolation (prod-absence proof)", () => {
	test("NODE_ENV=production: closes NOTHING, even authenticated sockets", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;

		const a = makeClient(true);
		const b = makeClient(true);
		track(a.ws);
		track(b.ws);

		// Sanity: these ARE the authed clients the registry would hand back.
		expect(getAuthenticatedClients()).toHaveLength(2);

		simulateDevReboot();
		await flushMacrotask();

		expect(a.closeCount()).toBe(0);
		expect(b.closeCount()).toBe(0);
	});
});
