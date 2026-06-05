import type { StreamHealthOutput } from "@ceraui/rpc/schemas";

import { broadcast } from "../../rpc/events.ts";
import {
	getMockHealth,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import { genSrtlaIpList } from "./srtla.ts";
import { getIsStreaming } from "./streaming.ts";

export interface LivenessSources {
	processAlive: boolean;
	framesAdvancing: boolean;
	frameCount: number;
	reconnecting: boolean;
	reconnectCount: number;
	linkCount: number;
	activeLinks: number;
}

export const HEALTH_EVENT_TYPE = "health";

/**
 * Tri-state derivation (Task 13 spec):
 *   dead     — process not alive
 *   degraded — alive BUT (frames not advancing OR fewer active links than expected)
 *   healthy  — alive AND frames advancing AND every bonded link active
 *
 * `linkCount` is the expected bonded-link count; `activeLinks` the currently-up
 * subset. Zero expected links cannot be healthy (there is no working bond).
 */
export function deriveStreamHealth(s: LivenessSources): StreamHealthOutput {
	let state: StreamHealthOutput["state"];
	if (!s.processAlive) {
		state = "dead";
	} else if (
		!s.framesAdvancing ||
		s.linkCount === 0 ||
		s.activeLinks < s.linkCount
	) {
		state = "degraded";
	} else {
		state = "healthy";
	}

	return {
		state,
		process: { alive: s.processAlive },
		frames: { advancing: s.framesAdvancing, count: s.frameCount },
		srt: { reconnecting: s.reconnecting, reconnectCount: s.reconnectCount },
		bond: { linkCount: s.linkCount, activeLinks: s.activeLinks },
	};
}

let sourcesOverride: (() => LivenessSources) | null = null;

export function setLivenessSourcesForTest(
	fn: (() => LivenessSources) | null,
): void {
	sourcesOverride = fn;
}

function collectMockLiveness(): LivenessSources {
	const h = getMockHealth();
	return {
		processAlive: h.processAlive,
		framesAdvancing: h.framesAdvancing,
		frameCount: h.frameCount,
		reconnecting: h.reconnecting,
		reconnectCount: h.reconnectCount,
		linkCount: h.linkCount,
		activeLinks: h.activeLinks,
	};
}

// Device path: ceracoder frame/reconnect telemetry (Task 8/12 C exports) is not
// yet surfaced through the TS bindings, so frame advancement tracks the running
// process and bond counts come from the configured srtla source-IP list. Wire
// the real ceracoder counters here once the bindings expose them.
function collectRealLiveness(): LivenessSources {
	const alive = getIsStreaming();
	const links = genSrtlaIpList().length;
	return {
		processAlive: alive,
		framesAdvancing: alive,
		frameCount: 0,
		reconnecting: false,
		reconnectCount: 0,
		linkCount: links,
		activeLinks: alive ? links : 0,
	};
}

export function collectLivenessSources(): LivenessSources {
	if (sourcesOverride) return sourcesOverride();
	if (shouldUseMocks()) return collectMockLiveness();
	return collectRealLiveness();
}

export function getStreamHealth(): StreamHealthOutput {
	return deriveStreamHealth(collectLivenessSources());
}

let lastBroadcastState: StreamHealthOutput["state"] | null = null;

export function resetHealthBroadcastState(): void {
	lastBroadcastState = null;
}

/**
 * Emit a `health` event only when the rolled-up state transitions. Called on the
 * existing 5s heartbeat tick — read-only, never triggers restart logic.
 */
export function broadcastHealthIfChanged(): StreamHealthOutput {
	const health = getStreamHealth();
	if (health.state !== lastBroadcastState) {
		lastBroadcastState = health.state;
		broadcast(HEALTH_EVENT_TYPE, health);
	}
	return health;
}
