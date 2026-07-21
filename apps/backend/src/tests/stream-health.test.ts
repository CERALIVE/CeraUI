import { afterEach, describe, expect, test } from "bun:test";

import { call } from "@orpc/server";
import {
	broadcastHealthIfChanged,
	deriveFramesAdvancing,
	deriveStreamHealth,
	HEALTH_EVENT_TYPE,
	type LivenessSources,
	resetHealthBroadcastState,
	setLivenessSourcesForTest,
} from "../modules/streaming/health.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { streamHealthProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const HEALTHY: LivenessSources = {
	isStreaming: true,
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
	isStreaming: true,
	processAlive: false,
	framesAdvancing: false,
	frameCount: 0,
	reconnecting: true,
	reconnectCount: 4,
	linkCount: 3,
	activeLinks: 0,
};

const IDLE: LivenessSources = {
	isStreaming: false,
	processAlive: null,
	framesAdvancing: null,
	frameCount: null,
	reconnecting: null,
	reconnectCount: 0,
	linkCount: 0,
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

describe("deriveStreamHealth — idle posture (idle != dead, Todo 19)", () => {
	test("not streaming renders idle with unknown (null) liveness, not dead", () => {
		const h = deriveStreamHealth(IDLE);
		expect(h.state).toBe("idle");
		expect(h.process.alive).toBeNull();
		expect(h.frames.advancing).toBeNull();
		expect(h.frames.count).toBeNull();
		expect(h.srt.reconnecting).toBeNull();
		expect(h.reason).toBeUndefined();
	});

	test("idle nullifies liveness even if the sources carry stale booleans", () => {
		// A collector that leaves concrete values while not streaming must still
		// render the honest idle posture — the state gate wins.
		const h = deriveStreamHealth({
			...IDLE,
			processAlive: false,
			framesAdvancing: false,
			frameCount: 0,
			reconnecting: false,
		});
		expect(h.state).toBe("idle");
		expect(h.process.alive).toBeNull();
		expect(h.frames.advancing).toBeNull();
		expect(h.srt.reconnecting).toBeNull();
	});

	test("idle carries the (truthful) bond counts through", () => {
		const h = deriveStreamHealth({ ...IDLE, linkCount: 2, activeLinks: 0 });
		expect(h.state).toBe("idle");
		expect(h.bond).toEqual({ linkCount: 2, activeLinks: 0 });
	});
});

describe("deriveStreamHealth — tri-state srt.reconnecting (fixtures only)", () => {
	// The honesty contract: the LIVE value is always `null`; these fixtures
	// exercise all three RENDERING states so the HUD + a future producer are
	// covered — no live true/false assertion exists anywhere.
	test("false renders as a concrete stable value", () => {
		expect(deriveStreamHealth(HEALTHY).srt.reconnecting).toBe(false);
	});

	test("true renders as a concrete reconnecting value", () => {
		const h = deriveStreamHealth({ ...HEALTHY, reconnecting: true });
		expect(h.srt.reconnecting).toBe(true);
		// reconnecting is display-only — it never flips the state away from healthy.
		expect(h.state).toBe("healthy");
	});

	test("null renders as unknown while streaming", () => {
		const h = deriveStreamHealth({ ...HEALTHY, reconnecting: null });
		expect(h.srt.reconnecting).toBeNull();
		expect(h.state).toBe("healthy");
	});
});

describe("deriveFramesAdvancing — real frame counter, never process liveness", () => {
	test("stale telemetry is never advancing (degraded)", () => {
		expect(deriveFramesAdvancing(false, true, true)).toBe(false);
	});

	test("fresh + counter advanced + pipeline playing => advancing", () => {
		expect(deriveFramesAdvancing(true, true, true)).toBe(true);
	});

	test("fresh + counter flat (stalled) => not advancing, even if playing", () => {
		expect(deriveFramesAdvancing(true, false, true)).toBe(false);
	});

	test("fresh + advanced but pipeline NOT playing => not advancing", () => {
		expect(deriveFramesAdvancing(true, true, false)).toBe(false);
	});

	test("first read (counter unknown): falls back to the real pipeline state", () => {
		expect(deriveFramesAdvancing(true, undefined, true)).toBe(true);
		expect(deriveFramesAdvancing(true, undefined, false)).toBe(false);
		expect(deriveFramesAdvancing(true, undefined, undefined)).toBe(false);
	});
});

describe("deriveStreamHealth — reason (Task 16)", () => {
	test("healthy carries no reason", () => {
		expect(deriveStreamHealth(HEALTHY).reason).toBeUndefined();
	});

	test("a down bond link reports the links component with a count detail", () => {
		expect(deriveStreamHealth(ONE_LINK_DOWN).reason).toEqual({
			component: "links",
			detail: "1 of 3 links down",
		});
	});

	test("a frame stall reports the frames component", () => {
		expect(deriveStreamHealth(FRAME_STALL).reason).toEqual({
			component: "frames",
			detail: "No frames advancing",
		});
	});

	test("zero configured links reports the links component", () => {
		expect(
			deriveStreamHealth({ ...HEALTHY, linkCount: 0, activeLinks: 0 }).reason,
		).toEqual({ component: "links", detail: "No bonded links configured" });
	});

	test("a dead process reports the process component", () => {
		expect(deriveStreamHealth(DEAD).reason).toEqual({
			component: "process",
			detail: "Streaming process not running",
		});
	});

	test("a single down link is singular-pluralized correctly", () => {
		expect(
			deriveStreamHealth({ ...HEALTHY, linkCount: 1, activeLinks: 0 }).reason,
		).toEqual({ component: "links", detail: "1 of 1 link down" });
	});
});

describe("streamHealth RPC procedure", () => {
	test("reports healthy from injected liveness sources", async () => {
		setLivenessSourcesForTest(() => HEALTHY);
		const result = await call(streamHealthProcedure, undefined, {
			context: makeContext(),
		});
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
