import { describe, expect, it } from "bun:test";

import {
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_STALE_THRESHOLD_MS,
	emitHeartbeat,
	isHeartbeatStale,
} from "../rpc/heartbeat.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

describe("isHeartbeatStale", () => {
	it("is stale one millisecond past the threshold", () => {
		expect(isHeartbeatStale(0, 15001, 15000)).toBe(true);
	});

	it("is not stale one millisecond before the threshold", () => {
		expect(isHeartbeatStale(0, 14999, 15000)).toBe(false);
	});

	it("is not stale when elapsed time exactly equals the threshold", () => {
		expect(isHeartbeatStale(5000, 20000, 15000)).toBe(false);
	});
});

describe("heartbeat constants", () => {
	it("emits on a ~5s interval", () => {
		expect(HEARTBEAT_INTERVAL_MS).toBe(5000);
	});

	it("treats ~15s (≈3 missed pings) as stale", () => {
		expect(HEARTBEAT_STALE_THRESHOLD_MS).toBe(15000);
	});
});

describe("emitHeartbeat", () => {
	function makeClient(sent: string[]): AppWebSocket {
		return {
			data: { isAuthenticated: true, lastActive: 0 },
			send: (msg: string) => {
				sent.push(msg);
			},
		} as unknown as AppWebSocket;
	}

	it("broadcasts an app-level { ping: { t } } message to authed clients", () => {
		const sent: string[] = [];
		const client = makeClient(sent);
		addClient(client);
		try {
			emitHeartbeat(1234);
		} finally {
			removeClient(client);
		}

		expect(sent).toHaveLength(1);
		const parsed = JSON.parse(sent[0] as string);
		expect(parsed.ping).toEqual({ t: 1234 });
	});
});
