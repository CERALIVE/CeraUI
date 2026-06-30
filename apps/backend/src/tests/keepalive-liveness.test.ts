import { describe, expect, it } from "bun:test";
import { createWebSocketHandler } from "../rpc/adapter.ts";
import { addClient, pruneStaleClients, removeClient } from "../rpc/events.ts";
import { HEARTBEAT_STALE_THRESHOLD_MS } from "../rpc/heartbeat.ts";
import type { AppWebSocket } from "../rpc/types.ts";

function makeClient(lastActive: number): {
	ws: AppWebSocket;
	closed: () => boolean;
} {
	let isClosed = false;
	const ws = {
		data: { isAuthenticated: true, lastActive },
		remoteAddress: "test",
		send: () => {},
		close: () => {
			isClosed = true;
		},
	} as unknown as AppWebSocket;
	return { ws, closed: () => isClosed };
}

// Regression for the every-~15s reconnect loop: an idle authenticated client
// making no RPC calls survives only because its keepalive/pong refreshes
// lastActive; pruneStaleClients() must then spare it. A genuinely silent
// (half-open) socket has no inbound frame and is still pruned.
describe("inbound frame refreshes lastActive (reconnect-loop regression)", () => {
	const handler = createWebSocketHandler();
	const stale = () => Date.now() - (HEARTBEAT_STALE_THRESHOLD_MS + 5_000);

	it("a keepalive frame advances lastActive so prune spares a live idle client", () => {
		const t0 = stale();
		const { ws, closed } = makeClient(t0);
		handler.message?.(ws, JSON.stringify({ keepalive: null }));
		expect(ws.data.lastActive).toBeGreaterThan(t0);
		addClient(ws);
		try {
			pruneStaleClients(HEARTBEAT_STALE_THRESHOLD_MS);
		} finally {
			removeClient(ws);
		}
		expect(closed()).toBe(false);
	});

	it("a pong frame advances lastActive", () => {
		const t0 = stale();
		const { ws } = makeClient(t0);
		handler.message?.(ws, JSON.stringify({ pong: true }));
		expect(ws.data.lastActive).toBeGreaterThan(t0);
	});

	it("a silent (half-open) socket with no inbound frame is still pruned", () => {
		const { ws, closed } = makeClient(stale());
		addClient(ws);
		try {
			pruneStaleClients(HEARTBEAT_STALE_THRESHOLD_MS);
		} finally {
			removeClient(ws);
		}
		expect(closed()).toBe(true);
	});
});
