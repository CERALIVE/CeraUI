/**
 * Local observability surface
 *
 * Read-only, LOCAL-ONLY health/metrics snapshot for on-device probing
 * (systemd watchdog, `curl localhost`, kiosk diagnostics). It reuses the Task 13
 * stream-health liveness rollup (`getStreamHealth`) as its single source of truth
 * — it does NOT re-derive process/frame/SRT/bond state — and decorates it with
 * process uptime and an ISO-8601 timestamp.
 *
 * NO outbound network. This module performs zero egress: no fetch, no socket, no
 * remote shipping (VictoriaMetrics/NATS/Vector are explicitly out of scope). The
 * surface is exposed over the already-bound local HTTP listener only.
 */
import type { StreamHealthOutput } from "@ceraui/rpc/schemas";

import { getStreamHealth } from "../streaming/health.ts";

export interface LocalObservabilitySurface {
	process: { alive: boolean; uptime: number };
	frames: { advancing: boolean; count: number };
	srt: { reconnecting: boolean; reconnectCount: number };
	bond: { linkCount: number; activeLinks: number };
	timestamp: string;
}

/**
 * Pure mapper: project a Task 13 health rollup onto the local surface shape,
 * decorated with the supplied uptime and timestamp. Side-effect-free and fully
 * deterministic for unit testing — all ambient inputs are injected.
 */
export function buildLocalObservabilitySurface(
	health: StreamHealthOutput,
	uptimeSeconds: number,
	now: Date = new Date(),
): LocalObservabilitySurface {
	return {
		process: { alive: health.process.alive, uptime: uptimeSeconds },
		frames: { advancing: health.frames.advancing, count: health.frames.count },
		srt: {
			reconnecting: health.srt.reconnecting,
			reconnectCount: health.srt.reconnectCount,
		},
		bond: {
			linkCount: health.bond.linkCount,
			activeLinks: health.bond.activeLinks,
		},
		timestamp: now.toISOString(),
	};
}

/**
 * Collect the live local observability surface. Reuses `getStreamHealth()` (the
 * canonical liveness source) and reads process uptime from the runtime — no
 * duplicated liveness logic, no network access.
 */
export function getLocalObservability(): LocalObservabilitySurface {
	return buildLocalObservabilitySurface(
		getStreamHealth(),
		Math.floor(process.uptime()),
	);
}
