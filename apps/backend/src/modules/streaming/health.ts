import type {
	StreamHealthOutput,
	StreamHealthReason,
} from "@ceraui/rpc/schemas";
import { getMockHealth, shouldUseMocks } from "../../mocks/mock-service.ts";
import { broadcast } from "../../rpc/events.ts";
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
function deriveReason(s: LivenessSources): StreamHealthReason | undefined {
	if (!s.processAlive) {
		return { component: "process", detail: "Streaming process not running" };
	}
	if (!s.framesAdvancing) {
		return { component: "frames", detail: "No frames advancing" };
	}
	if (s.linkCount === 0) {
		return { component: "links", detail: "No bonded links configured" };
	}
	if (s.activeLinks < s.linkCount) {
		const down = s.linkCount - s.activeLinks;
		return {
			component: "links",
			detail: `${down} of ${s.linkCount} link${s.linkCount === 1 ? "" : "s"} down`,
		};
	}
	return undefined;
}

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

	const reason = state === "healthy" ? undefined : deriveReason(s);

	return {
		state,
		...(reason ? { reason } : {}),
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

// getMockHealth() now derives liveness from the mock streaming/srtla engine
// state (process active, connected-relay count) rather than disconnected manual
// setters, so this rollup reflects the mock engine; manual override stays
// available for edge-case tests via setMockHealth().
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

// Set when a supervised streaming process exits unexpectedly. Per ADR-0005,
// streamloop observes the exit and marks the stream dead — it never respawns
// (systemd is the sole restart authority). Cleared when a new stream starts.
let processExited = false;

export function reportStreamProcessExit(): void {
	processExited = true;
}

export function clearStreamProcessExit(): void {
	processExited = false;
}

// Device path: engine frame/reconnect telemetry is not yet folded into this
// rollup, so frame advancement tracks the running process and bond counts come
// from the configured srtla source-IP list. Wire the real cerastream telemetry
// counters here once the rollup consumes them.
function collectRealLiveness(): LivenessSources {
	const alive = getIsStreaming() && !processExited;
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
