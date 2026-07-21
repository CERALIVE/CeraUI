import type {
	StreamHealthOutput,
	StreamHealthReason,
} from "@ceraui/rpc/schemas";
import { getMockHealth, shouldUseMocks } from "../../mocks/mock-service.ts";
import { broadcast } from "../../rpc/events.ts";
import { getActiveEncodeLiveness } from "./active-passthrough.ts";
import { reportAllLinksDown } from "./lifecycle-indicators.ts";
import { buildLinkTelemetry } from "./link-telemetry.ts";
import { genSrtlaIpList } from "./srtla.ts";
import { getIsStreaming } from "./streaming.ts";

/**
 * Real device-health signals. `isStreaming` gates the IDLE posture: while a
 * stream is NOT requested, process/frame/SRT liveness is UNKNOWN (`null`), never
 * a "dead" claim. `reconnecting` is TRI-STATE (`true|false|null`) — `null` is the
 * honest value from the current stats-file source, which carries no reconnect
 * flag. `framesAdvancing` is derived from the engine's real frame counter (never
 * equated with process liveness).
 */
export interface LivenessSources {
	isStreaming: boolean;
	processAlive: boolean | null;
	framesAdvancing: boolean | null;
	frameCount: number | null;
	reconnecting: boolean | null;
	reconnectCount: number;
	linkCount: number;
	activeLinks: number;
}

export const HEALTH_EVENT_TYPE = "health";

/**
 * The `active_encode` liveness telemetry is stale past this window ⇒ the stream
 * is treated as not advancing (degraded). Sized above the engine's 2 s status
 * heartbeat cadence so a single dropped heartbeat does not flap the verdict.
 */
export const FRAMES_FRESHNESS_MS = 5000;

let nowFn: () => number = Date.now;

/** Test seam: pin the freshness clock (null restores Date.now). */
export function setHealthClockForTest(fn: (() => number) | null): void {
	nowFn = fn ?? Date.now;
}

/**
 * Resolve `frames.advancing` from the real engine signals. Stale telemetry ⇒ not
 * advancing; otherwise the frame counter must have increased across two
 * consecutive reads AND the pipeline be PLAYING. On the first read (only one
 * counter seen) the pipeline-PLAYING state stands in — a real signal, never a
 * hardcoded assumption.
 */
export function deriveFramesAdvancing(
	fresh: boolean,
	advancingByCounter: boolean | undefined,
	pipelinePlaying: boolean | undefined,
): boolean {
	if (!fresh) return false;
	const playing = pipelinePlaying === true;
	if (advancingByCounter === undefined) return playing;
	return advancingByCounter && playing;
}

/**
 * State machine:
 *   idle     — no stream requested (device up, liveness unknown — NOT "dead")
 *   dead     — streaming but the process is not alive
 *   degraded — alive BUT (frames not advancing OR fewer active links than expected)
 *   healthy  — alive AND frames advancing AND every bonded link active
 *
 * `reconnecting` is display-only tri-state; it never drives the state (the live
 * value is always `null`, so it could not honestly gate degraded today).
 */
function deriveReason(s: LivenessSources): StreamHealthReason | undefined {
	if (!s.isStreaming) return undefined;
	if (s.processAlive !== true) {
		return { component: "process", detail: "Streaming process not running" };
	}
	if (s.framesAdvancing !== true) {
		return { component: "frames", detail: "No frames advancing" };
	}
	if (s.linkCount === 0) {
		return { component: "links", detail: "No bonded links configured" };
	}
	if (s.activeLinks === 0) {
		return {
			component: "links",
			detail: `All ${s.linkCount} link${s.linkCount === 1 ? "" : "s"} down \u2014 no data can be sent`,
		};
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
	const idle = !s.isStreaming;
	let state: StreamHealthOutput["state"];
	if (idle) {
		state = "idle";
	} else if (s.processAlive !== true) {
		state = "dead";
	} else if (
		s.framesAdvancing !== true ||
		s.linkCount === 0 ||
		s.activeLinks < s.linkCount
	) {
		state = "degraded";
	} else {
		state = "healthy";
	}

	const reason =
		state === "healthy" || state === "idle" ? undefined : deriveReason(s);

	return {
		state,
		...(reason ? { reason } : {}),
		process: { alive: idle ? null : s.processAlive },
		frames: {
			advancing: idle ? null : s.framesAdvancing,
			count: idle ? null : s.frameCount,
		},
		srt: {
			reconnecting: idle ? null : s.reconnecting,
			reconnectCount: s.reconnectCount,
		},
		bond: { linkCount: s.linkCount, activeLinks: s.activeLinks },
	};
}

let sourcesOverride: (() => LivenessSources) | null = null;

export function setLivenessSourcesForTest(
	fn: (() => LivenessSources) | null,
): void {
	sourcesOverride = fn;
}

// getMockHealth() derives liveness from the mock streaming/srtla engine state,
// so this rollup reflects the mock engine; the mock's `processAlive` tracks the
// streaming-active flag, so it is the mock's `isStreaming` (idle ⇒ idle posture).
// Manual override stays available for edge-case tests via setMockHealth().
function collectMockLiveness(): LivenessSources {
	const h = getMockHealth();
	return {
		isStreaming: h.processAlive,
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

// Bond counts from the srtla stats file's per-link entries (fresh-within-threshold
// = active). No telemetry snapshot yet while streaming ⇒ fall back to the
// configured source-IP count so the bond is not misreported as "none configured"
// during the first ~1s before srtla_send writes its stats (none are active yet).
// Idle ⇒ no srtla process, no telemetry ⇒ 0/0.
function deriveBond(isStreaming: boolean): {
	linkCount: number;
	activeLinks: number;
} {
	const telemetry = buildLinkTelemetry();
	if (telemetry) {
		return {
			linkCount: telemetry.links.length,
			activeLinks: telemetry.links.filter((link) => !link.stale).length,
		};
	}
	if (isStreaming)
		return { linkCount: genSrtlaIpList().length, activeLinks: 0 };
	return { linkCount: 0, activeLinks: 0 };
}

// Device path: truthful telemetry — process liveness from the supervised stream
// process, frame advancement from the engine's real `active_encode.frames_emitted`
// counter (raw event bridge), bond from the srtla stats file. NO synthetic values:
// SRT reconnect is `null` (the stats-file source carries no reconnect flag), and
// idle reports the IDLE posture (process/frames/SRT unknown), never "dead".
function collectRealLiveness(): LivenessSources {
	const isStreaming = getIsStreaming();
	const bond = deriveBond(isStreaming);

	if (!isStreaming) {
		return {
			isStreaming: false,
			processAlive: null,
			framesAdvancing: null,
			frameCount: null,
			reconnecting: null,
			reconnectCount: 0,
			linkCount: bond.linkCount,
			activeLinks: bond.activeLinks,
		};
	}

	const processAlive = !processExited;
	const live = getActiveEncodeLiveness();
	// No liveness telemetry AT ALL (a pre-0.7.0 engine, or the first heartbeat has
	// not yet arrived): no frame signal exists to prove advancement or a stall, so
	// fall back to process liveness. Once the engine reports `active_encode`
	// liveness, the truthful counter/PLAYING derivation takes over.
	let framesAdvancing: boolean;
	let frameCount: number | null;
	if (live === undefined) {
		framesAdvancing = processAlive;
		frameCount = null;
	} else {
		const fresh = nowFn() - live.lastStatusAtMs <= FRAMES_FRESHNESS_MS;
		framesAdvancing = deriveFramesAdvancing(
			fresh,
			live.framesAdvancing,
			live.pipelinePlaying,
		);
		frameCount = live.framesEmitted ?? null;
	}

	return {
		isStreaming: true,
		processAlive,
		framesAdvancing,
		frameCount,
		reconnecting: null,
		reconnectCount: 0,
		linkCount: bond.linkCount,
		activeLinks: bond.activeLinks,
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
	const sources = collectLivenessSources();
	const health = deriveStreamHealth(sources);
	if (health.state !== lastBroadcastState) {
		lastBroadcastState = health.state;
		broadcast(HEALTH_EVENT_TYPE, health);
	}
	// Lifecycle indicator: all bonded links down mid-stream (0 active of N>0) is a
	// distinct notification from the health "degraded" state; evaluated every tick
	// so a link recovering clears it with a transient "links recovered" toast.
	reportAllLinksDown({
		isStreaming: sources.isStreaming,
		linkCount: sources.linkCount,
		activeLinks: sources.activeLinks,
	});
	return health;
}
