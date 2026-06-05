import { afterEach, describe, expect, test } from "bun:test";

import { call } from "@orpc/server";

import { addClient, removeClient } from "../rpc/events.ts";
import {
	type LivenessSources,
	HEALTH_EVENT_TYPE,
	broadcastHealthIfChanged,
	deriveStreamHealth,
	resetHealthBroadcastState,
	setLivenessSourcesForTest,
} from "../modules/streaming/health.ts";
import { streamHealthProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const HEALTHY: LivenessSources = {
	processAlive: true,
	framesAdvancing: true,
	frameCount: 1500,
	reconnecting: false,
	reconnectCount: 0,
	linkCount: 3,
	activeLinks: 3,
};

const FRAME_STALL: LivenessSources = {
	...HEALTHY,
	framesAdvancing: false,
	frameCount: 1500,
};

const ONE_LINK_DOWN: LivenessSources = {
	...HEALTHY,
	activeLinks: 2,
};

const DEAD: LivenessSources = {
	processAlive: false,
	framesAdvancing: false,
	frameCount: 0,
	reconnecting: true,
	reconnectCount: 4,
	linkCount: 3,
	activeLinks: 0,
};

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function captureClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

afterEach(() => {
	setLivenessSourcesForTest(null);
	resetHealthBroadcastState();
});

describe("deriveStreamHealth — tri-state derivation", () => {
	test("healthy when process alive, frames advancing, all links active", () => {
		const h = deriveStreamHealth(HEALTHY);
		expect(h.state).toBe("healthy");
		expect(h.process.alive).toBe(true);
		expect(h.frames.advancing).toBe(true);
		expect(h.bond).toEqual({ linkCount: 3, activeLinks: 3 });
	});

	test("degraded when frames stall but process is alive", () => {
		const h = deriveStreamHealth(FRAME_STALL);
		expect(h.state).toBe("degraded");
		expect(h.process.alive).toBe(true);
		expect(h.frames.advancing).toBe(false);
	});

	test("degraded when one bond link is down", () => {
		const h = deriveStreamHealth(ONE_LINK_DOWN);
		expect(h.state).toBe("degraded");
		expect(h.bond.activeLinks).toBeLessThan(h.bond.linkCount);
	});

	test("degraded when alive but zero links are configured", () => {
		const h = deriveStreamHealth({
			...HEALTHY,
			linkCount: 0,
			activeLinks: 0,
		});
		expect(h.state).toBe("degraded");
	});

	test("dead when the process is gone, regardless of stale link counts", () => {
		const h = deriveStreamHealth(DEAD);
		expect(h.state).toBe("dead");
		expect(h.process.alive).toBe(false);
		expect(h.srt).toEqual({ reconnecting: true, reconnectCount: 4 });
	});
});

describe("streamHealth RPC procedure", () => {
	test("reports healthy from injected liveness sources", async () => {
		setLivenessSourcesForTest(() => HEALTHY);
		const result = await call(
			streamHealthProcedure,
			undefined,
			{ context: makeContext() },
		);
		expect(result.state).toBe("healthy");
		expect(result.frames.count).toBe(1500);
		expect(result.bond.activeLinks).toBe(result.bond.linkCount);
	});

	test("reports degraded on frame stall", async () => {
		setLivenessSourcesForTest(() => FRAME_STALL);
		const result = await call(streamHealthProcedure, undefined, {
			context: makeContext(),
		});
		expect(result.state).toBe("degraded");
	});

	test("reports dead when the process is gone", async () => {
		setLivenessSourcesForTest(() => DEAD);
		const result = await call(streamHealthProcedure, undefined, {
			context: makeContext(),
		});
		expect(result.state).toBe("dead");
		expect(result.srt.reconnectCount).toBe(4);
	});
});

describe("broadcastHealthIfChanged — transition-only broadcast", () => {
	function healthPayloads(raw: string[]) {
		return raw
			.map((line) => JSON.parse(line))
			.filter(
				(obj): obj is { health: { state: string } } =>
					!!obj && typeof obj === "object" && HEALTH_EVENT_TYPE in obj,
			)
			.map((obj) => obj.health);
	}

	test("emits a health event on each state transition, suppressing duplicates", () => {
		const sink: string[] = [];
		const client = captureClient(sink);
		addClient(client);
		try {
			let source: LivenessSources = HEALTHY;
			setLivenessSourcesForTest(() => source);

			broadcastHealthIfChanged();
			broadcastHealthIfChanged();

			source = FRAME_STALL;
			broadcastHealthIfChanged();

			source = DEAD;
			broadcastHealthIfChanged();

			const states = healthPayloads(sink).map((h) => h.state);
			expect(states).toEqual(["healthy", "degraded", "dead"]);
		} finally {
			removeClient(client);
		}
	});

	test("returns the current health even when no broadcast fires", () => {
		setLivenessSourcesForTest(() => HEALTHY);
		const first = broadcastHealthIfChanged();
		expect(first.state).toBe("healthy");
		const second = broadcastHealthIfChanged();
		expect(second.state).toBe("healthy");
	});
});
