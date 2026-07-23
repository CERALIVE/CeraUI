/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project


    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Engine (cerastream) connection resilience.
//
// The capability contract is fetched over a SHORT-LIVED probe connection to the
// systemd-owned cerastream control socket (`capabilities.ts` →
// `defaultFetchEngineCapabilities`: connect → get-capabilities → close). At boot
// that probe is attempted exactly once via `guardNonCritical("pipelines", …)`.
// If cerastream is not up yet — a real systemd-ordering race seen in the field —
// the fallback ladder serves `engineUnavailable`/`engineStarting` and, before this
// module, the engine stayed marked unavailable PERMANENTLY: no retry, no periodic
// recheck, so the "Streaming engine offline" banner never cleared even though
// cerastream came up healthy moments later.
//
// The `@ceralive/cerastream` client DOES expose an `autoReconnect` ConnectOptions
// flag, but it only rescues an ALREADY-established connection that later drops and
// throws immediately on the FIRST connect failure — so it cannot help a fresh
// per-fetch probe, and it emits no "became available" event. The offline→available
// recovery therefore lives here, backend-side.
//
// This module owns ONE self-rescheduling reconnect loop that serves both roles the
// resilience gap needs:
//
//   1. Bounded boot retry — the first attempt is awaited so the pipeline registry
//      is populated before the rest of boot reads it; the next few backoff steps
//      (~2s, 4s, 8s, 16s → ceiling) are the "short exponential backoff over the
//      first ~30-60s" that resolves a normal engine-not-ready-yet race with no
//      operator intervention.
//   2. Periodic background recheck — once backoff caps at the ceiling it becomes a
//      slow (~30s) health-recheck that keeps running so a device self-heals even
//      minutes/hours later. It is BOUNDED (a fixed ceiling, never a tight loop): a
//      masked/disabled cerastream just gets a cheap periodic poll, never hammering.
//
// On the unavailable→reachable transition it re-broadcasts `capabilities`,
// `pipelines`, and `sources` to already-connected clients (so the offline banner
// clears live, no page reload) and then SETTLES — the boot race is resolved. It
// feeds INTO the existing `engine-unavailable`/`engine-starting` capability tier
// state machine (reachability = a live `getLastCapabilities()` snapshot); it does
// not create a parallel one.
//
// Every collaborator is injected (`EngineReconnectDeps`, mirroring `channel.ts` /
// `boot-guard.ts`) so the loop is unit-testable without real timers or a socket.

import { logger as defaultLogger } from "../../helpers/logger.ts";
import { getHardwareKind } from "../system/hardware-kind.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import {
	type CapabilitiesServiceDeps,
	getLastCapabilities,
} from "./capabilities.ts";
import { reportEngineState } from "./lifecycle-indicators.ts";
import { getPipelinesMessage, initPipelines } from "./pipelines.ts";
import {
	type EngineDeviceCacheDeps,
	refreshAndBroadcastSources,
} from "./sources.ts";
import { reconcileStreamSession } from "./stream-session-orchestrator.ts";
import { getIsStreaming } from "./streaming.ts";

/**
 * Reconnect backoff bounds. Mirrors `modules/remote-control/channel.ts`: an
 * exponential base that caps at a ceiling so the loop never hammers a socket that
 * will not come back. The first steps (~2s, 4s, 8s, 16s) cover the brief
 * engine-not-ready race; once capped, the ceiling IS the periodic recheck cadence.
 */
export const ENGINE_RECONNECT_BASE_MS = 2_000;
export const ENGINE_RECONNECT_MAX_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;

/** Minimal logger surface (winston satisfies it; tests pass a silent stub). */
export interface EngineReconnectLogger {
	info(message: string): void;
	warn(message: string): void;
}

/** Injected collaborators; defaults wire the real capability/broadcast path. */
export interface EngineReconnectDeps {
	/**
	 * Re-attempt the engine connection and refresh the capability contract. MUST
	 * NOT throw (the capability ladder never does) — the loop treats a resolve as
	 * "attempt made" and reads reachability separately.
	 */
	refreshCapabilities: () => Promise<void>;
	/**
	 * Whether the last refresh produced a LIVE snapshot (engine reachable). A
	 * cached/minimal fallback (`engineUnavailable`) reads as unreachable.
	 */
	isEngineReachable: () => boolean;
	/**
	 * Re-broadcast the engine-derived state (`capabilities` + `pipelines` +
	 * `sources`) to already-connected clients. Called ONCE on the
	 * unavailable→reachable transition so the offline banner clears live.
	 */
	broadcastEngineState: () => Promise<void> | void;
	/**
	 * Report the engine reachability edge for the crash/recovered lifecycle
	 * indicator. Gated on `isStreaming` inside the reporter: only a mid-stream
	 * unreachable→reachable transition toasts.
	 */
	reportEngineState: (reachable: boolean) => void;
	logger: EngineReconnectLogger;
	random: () => number;
	setTimer: (fn: () => void, ms: number) => TimerHandle;
	clearTimer: (timer: TimerHandle) => void;
	/** Backoff base; overridable for tests. */
	baseDelayMs: number;
	/** Backoff ceiling (the eventual periodic-recheck cadence); overridable. */
	maxDelayMs: number;
}

/**
 * The engine-fetcher overrides threaded into the DEFAULT `refreshCapabilities` /
 * `broadcastEngineState` wiring. These mirror the exact bags `main.ts` already
 * passes to `initPipelines` (capability fetch) and `refreshAndBroadcastSources`
 * (device fold) at boot, so the reconnect loop refreshes through the SAME seam —
 * the real engine socket in production, the scenario mock fetchers in dev/e2e.
 * Omit both (production) and the real cerastream probe is used.
 */
export interface EngineConnectionOverrides {
	/** Threaded into `initPipelines()` (→ `getCapabilities`) on each refresh. */
	capabilities?: Partial<CapabilitiesServiceDeps>;
	/** Threaded into `refreshAndBroadcastSources()` on each heal broadcast. */
	sources?: EngineDeviceCacheDeps;
}

/**
 * Build the DEFAULT `broadcastEngineState`: re-push the engine-derived snapshots to
 * every connected client. Identical to the `setMockHardware` RPC's re-broadcast trio
 * (`streaming.procedure.ts`) — capabilities THEN pipelines THEN the folded sources,
 * so a client already on the Live view self-heals without a reload. Best-effort: a
 * null capability snapshot or a sources refresh failure is swallowed by the loop's
 * own catch.
 */
function buildDefaultBroadcastEngineState(
	sourcesOverride: EngineDeviceCacheDeps | undefined,
): () => Promise<void> {
	return async () => {
		// Ordering is load-bearing: re-resolve the hardware kind BEFORE the
		// pipelines/sources broadcasts, which read the freshly-cached kind live via
		// getEffectiveHardware(). The engine is reachable again, so its
		// platform.hardware_kind now supersedes any boot-time fallback.
		await getHardwareKind();
		broadcastMsg("capabilities", getLastCapabilities());
		broadcastMsg("pipelines", getPipelinesMessage());
		await (sourcesOverride
			? refreshAndBroadcastSources(sourcesOverride)
			: refreshAndBroadcastSources());
		if (sourcesOverride === undefined) await reconcileStreamSession();
	};
}

function defaultDeps(
	fetchers: EngineConnectionOverrides = {},
): EngineReconnectDeps {
	const capsOverride = fetchers.capabilities ?? {};
	return {
		refreshCapabilities: () => initPipelines(capsOverride),
		isEngineReachable: () => getLastCapabilities()?.engineUnavailable === false,
		broadcastEngineState: buildDefaultBroadcastEngineState(fetchers.sources),
		reportEngineState: (reachable) =>
			reportEngineState({ isStreaming: getIsStreaming(), reachable }),
		logger: defaultLogger,
		random: Math.random,
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (timer) => clearTimeout(timer),
		baseDelayMs: ENGINE_RECONNECT_BASE_MS,
		maxDelayMs: ENGINE_RECONNECT_MAX_MS,
	};
}

interface ReconnectState {
	deps: EngineReconnectDeps;
	attempt: number;
	timer: TimerHandle | undefined;
	stopped: boolean;
	/** Tail of the in-flight background attempt (test seam via settleEngineReconnect). */
	inflight: Promise<void>;
}

// Process-wide singleton (mirrors channel.ts module-state posture).
let state: ReconnectState | undefined;

/**
 * Exponential backoff with equal jitter: `base·2^attempt` capped at `max`, then a
 * random point in the upper half `[cap/2, cap]`. Mirrors `channel.ts` `backoffDelay`
 * so the two reconnect surfaces share one shape; parameterized here so the module
 * stays self-contained. The jitter de-synchronises a fleet rechecking after a shared
 * boot race so they never thundering-herd the engine socket.
 */
export function backoffDelay(
	attempt: number,
	baseMs: number,
	maxMs: number,
	random: () => number,
): number {
	const capped = Math.min(baseMs * 2 ** attempt, maxMs);
	return capped / 2 + random() * (capped / 2);
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Run one connection attempt: refresh capabilities, then — when asked — broadcast
 * the healed state if the engine became reachable. `refreshCapabilities` and
 * `broadcastEngineState` are both wrapped so a stray throw can never break the loop.
 *
 * Returns whether the loop may SETTLE: `true` only once the engine is reachable AND
 * (for a heal attempt) the re-broadcast to clients actually completed. A reachable
 * engine whose heal broadcast THROWS returns `false` so the caller keeps retrying —
 * otherwise a transient error from any broadcast collaborator would strand
 * already-connected clients on the offline banner until a manual reload, violating
 * this module's "clients are updated before the loop settles" invariant.
 */
async function runAttempt(broadcastOnHeal: boolean): Promise<boolean> {
	if (!state) return false;
	const { deps } = state;
	try {
		await deps.refreshCapabilities();
	} catch (err) {
		// The capability ladder never throws; defend anyway so a future change
		// can't silently kill the recovery loop.
		deps.logger.warn(
			`engine reconnect: capability refresh threw: ${errMessage(err)}`,
		);
	}
	if (!state) return false;
	deps.reportEngineState(deps.isEngineReachable());
	if (!deps.isEngineReachable()) return false;
	if (!broadcastOnHeal) return true;
	try {
		await deps.broadcastEngineState();
		deps.logger.info(
			"engine reconnect: engine reachable again; re-broadcast capabilities/pipelines/sources to clients",
		);
		return true;
	} catch (err) {
		deps.logger.warn(
			`engine reconnect: heal broadcast failed, will retry: ${errMessage(err)}`,
		);
		return false;
	}
}

/**
 * Schedule the next background recheck (single in-flight timer; never stacked).
 * No-op once the loop has settled or been torn down.
 */
function scheduleRecheck(): void {
	if (!state || state.stopped || state.timer !== undefined) return;
	const { deps } = state;
	const delay = backoffDelay(
		state.attempt,
		deps.baseDelayMs,
		deps.maxDelayMs,
		deps.random,
	);
	state.attempt += 1;
	deps.logger.info(
		`engine reconnect: rechecking engine in ${Math.round(delay)}ms (attempt ${state.attempt})`,
	);
	state.timer = deps.setTimer(() => {
		if (!state) return;
		state.timer = undefined;
		state.inflight = tickRecheck();
	}, delay);
}

/**
 * One background recheck tick: attempt, then either settle (engine healed AND
 * clients re-broadcast) or schedule the next recheck (still down, or the heal
 * broadcast threw). Settling is gated on `runAttempt`'s result — a reachable
 * engine whose broadcast throws does NOT settle, it reschedules — so clients are
 * never left on the offline banner while the loop silently gives up.
 */
async function tickRecheck(): Promise<void> {
	if (!state || state.stopped) return;
	const healed = await runAttempt(true);
	if (!state || state.stopped) return;
	if (healed) {
		// Healed — the boot race is resolved and clients are updated; settle so we
		// stop polling.
		state.stopped = true;
		state.timer = undefined;
		return;
	}
	scheduleRecheck();
}

/**
 * Boot entry point. Runs the FIRST engine connection attempt synchronously (so the
 * pipeline registry is populated before the rest of boot reads it), then — if the
 * engine is not yet reachable — arms the background reconnect loop so a slow-starting
 * or briefly-unreachable engine self-heals without an operator restart.
 *
 * Fail-soft: `refreshCapabilities` never throws, so this resolves even when the
 * engine is down; the background loop is fire-and-forget and never blocks boot.
 * Idempotent — a prior loop is torn down first.
 */
export async function initEngineConnection(
	options: EngineConnectionOverrides & Partial<EngineReconnectDeps> = {},
): Promise<void> {
	const { capabilities, sources, ...depOverrides } = options;
	const fetchers: EngineConnectionOverrides = {
		...(capabilities !== undefined ? { capabilities } : {}),
		...(sources !== undefined ? { sources } : {}),
	};
	const deps: EngineReconnectDeps = {
		...defaultDeps(fetchers),
		...depOverrides,
	};

	stopEngineReconnect();
	state = {
		deps,
		attempt: 0,
		timer: undefined,
		stopped: false,
		inflight: Promise.resolve(),
	};

	// First attempt is awaited (no heal broadcast — there are no clients yet at
	// boot, and boot's own snapshot/sources steps run right after).
	await runAttempt(false);

	if (!state) return;
	if (deps.isEngineReachable()) {
		deps.logger.info("engine reconnect: engine reachable at boot");
		state.stopped = true;
		return;
	}

	deps.logger.warn(
		"engine reconnect: engine unreachable at boot; scheduling background reconnect",
	);
	scheduleRecheck();
}

/**
 * Test seam: resolve once the in-flight background recheck has settled (mirrors
 * `CerastreamBackend.settle()`). Returns immediately when no attempt is in flight.
 */
export function settleEngineReconnect(): Promise<void> {
	return state?.inflight ?? Promise.resolve();
}

/**
 * Tear down the reconnect loop (clear the timer, drop state). Idempotent — safe to
 * call when never started. Keeps `initEngineConnection` re-entrant across reboots
 * and test cases.
 */
export function stopEngineReconnect(): void {
	if (!state) return;
	if (state.timer !== undefined) {
		state.deps.clearTimer(state.timer);
	}
	state.stopped = true;
	state = undefined;
}
