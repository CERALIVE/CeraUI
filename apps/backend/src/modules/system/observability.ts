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
import { type BootReadiness, getBootReadiness } from "./readiness.ts";

export interface LocalObservabilitySurface {
	// Mirrors the tri-state health rollup. `null` = unknown (idle posture / no
	// reconnect flag), never coerced to a boolean — so `curl /api/health` on an
	// idle device reads the truthful `state:"idle"` + `alive:null`, not a
	// misleading `alive:false` that looks "dead".
	state: StreamHealthOutput["state"];
	process: { alive: boolean | null; uptime: number };
	frames: { advancing: boolean | null; count: number | null };
	srt: { reconnecting: boolean | null; reconnectCount: number };
	bond: { linkCount: number; activeLinks: number };
	timestamp: string;
	/**
	 * Boot-readiness rollup (S6): present when supplied. `degraded` flips true
	 * when any non-critical boot init failed, so an operator polling
	 * `/api/health` sees a readiness-reduced device even though the WS control
	 * server bound and the stream may be healthy.
	 */
	readiness?: BootReadiness;
}

/**
 * Pure mapper: project a Task 13 health rollup onto the local surface shape,
 * decorated with the supplied uptime and timestamp. Side-effect-free and fully
 * deterministic for unit testing — all ambient inputs are injected. `readiness`
 * is optional so existing callers/tests are unaffected; it is only attached when
 * a snapshot is passed.
 */
export function buildLocalObservabilitySurface(
	health: StreamHealthOutput,
	uptimeSeconds: number,
	now: Date = new Date(),
	readiness?: BootReadiness,
): LocalObservabilitySurface {
	return {
		state: health.state,
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
		...(readiness ? { readiness } : {}),
	};
}

/**
 * Collect the live local observability surface. Reuses `getStreamHealth()` (the
 * canonical liveness source), reads process uptime from the runtime, and folds
 * in the boot-readiness rollup — no duplicated liveness logic, no network access.
 */
export function getLocalObservability(): LocalObservabilitySurface {
	return buildLocalObservabilitySurface(
		getStreamHealth(),
		Math.floor(process.uptime()),
		new Date(),
		getBootReadiness(),
	);
}
