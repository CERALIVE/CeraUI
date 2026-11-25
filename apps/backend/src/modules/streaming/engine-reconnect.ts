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
//   3. Re-arm after a later loss: once settled, `rearmEngineReconnect()` starts
//      the same loop again whenever the engine connection is proven lost after
//      boot (a session's control connection closed or failed, or a start
//      could not reach the engine). A hung engine is covered too: its watchdog
//      kills it within 90 s, and that closes the socket. Without it a watchdog restart of
//      cerastream left the capability snapshot marked unavailable for the rest
//      of the process: the offline banner stayed and Start stayed blocked until
//      the backend itself restarted. A loss shortly after a heal keeps the
//      backoff where it was, so an engine that keeps crashing is rechecked ever
//      more slowly instead of every second.
//
// On the unavailable→reachable transition it re-broadcasts `capabilities`,
// `pipelines`, and `sources` to already-connected clients (so the offline banner
// clears live, no page reload) and then SETTLES until the next loss. The boot
// heal also settles the boot race (session reconcile, in-flight config change,
// restoration). A heal after a re-arm does only the publishing: the session,
// its cleanup and restoration already have their own triggers on a loss, and a
// second reconcile here would supersede their pending observations. It
// feeds INTO the existing `engine-unavailable`/`engine-starting` capability tier
// state machine (reachability = a live `getLastCapabilities()` snapshot); it does
// not create a parallel one.
//
// Every collaborator is injected (`EngineReconnectDeps`, mirroring `channel.ts` /
// `boot-guard.ts`) so the loop is unit-testable without real timers or a socket.

import { logger as defaultLogger } from "../../helpers/logger.ts";
import { bindEngineRecoveryShutdown } from "../../helpers/shutdown.ts";
import { emitEvent } from "../events/emit.ts";
import { getHardwareKind } from "../system/hardware-kind.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import {
	type CapabilitiesServiceDeps,
	getLastCapabilities,
	invalidateCapabilities,
} from "./capabilities.ts";
import { runInflightConfigChangeReconciliation } from "./config-change-reconcile-wiring.ts";
import { bindEngineControlLoss } from "./engine-control-loss.ts";
import {
	reportEngineRecovery,
	reportEngineState,
} from "./lifecycle-indicators.ts";
import { getPipelinesMessage, initPipelines } from "./pipelines.ts";
import {
	type EngineDeviceCacheDeps,
	refreshAndBroadcastSources,
} from "./sources.ts";
import { runStreamRestoration } from "./stream-restoration.ts";
import {
	reconcileLostStreamSession,
	reconcileStreamSession,
} from "./stream-session-orchestrator.ts";
import { getIsStreaming } from "./streaming.ts";
import { getStreamingBackend } from "./streaming-engine.ts";

/**
 * Reconnect backoff bounds. Mirrors `modules/remote-control/channel.ts`: an
 * exponential base that caps at a ceiling so the loop never hammers a socket that
 * will not come back. The first steps (~2s, 4s, 8s, 16s) cover the brief
 * engine-not-ready race; once capped, the ceiling IS the periodic recheck cadence.
 */
export const ENGINE_RECONNECT_BASE_MS = 2_000;
export const ENGINE_RECONNECT_MAX_MS = 30_000;
/**
 * A loss within this long of the last heal continues the previous backoff
 * instead of starting again at the base delay, so a flapping engine is not
 * probed at the fastest cadence after every crash.
 */
export const ENGINE_RECONNECT_FLAP_WINDOW_MS = 60_000;
const ENGINE_CONTROL_LIVENESS_MS = 15_000;

type TimerHandle = ReturnType<typeof setTimeout>;

/** Minimal logger surface (winston satisfies it; tests pass a silent stub). */
export interface EngineReconnectLogger {
	debug?(message: string): void;
	info(message: string): void;
	warn(message: string): void;
}

/** Injected collaborators; defaults wire the real capability/broadcast path. */
export interface EngineReconnectDeps {
	onUnavailable?: () => void;
	onRecovered?: (streaming: boolean) => void;
	/**
	 * Re-attempt the engine connection and refresh the capability contract. MUST
	 * NOT throw (the capability ladder never does) — the loop treats a resolve as
	 * "attempt made" and reads reachability separately.
	 */
	refreshCapabilities: (current: () => boolean) => Promise<void>;
	/**
	 * Whether the last refresh produced a LIVE snapshot (engine reachable). A
	 * cached/minimal fallback (`engineUnavailable`) reads as unreachable.
	 */
	isEngineReachable: () => boolean;
	/**
	 * Boot heal: re-broadcast the engine-derived state (`capabilities` +
	 * `pipelines` + `sources`) to already-connected clients and settle the boot
	 * race. Called ONCE on the unavailable→reachable transition of the boot loop.
	 * `alive` turns false once the loop is torn down; later steps are skipped.
	 */
	broadcastEngineState: (alive: () => boolean) => Promise<void> | void;
	/**
	 * Heal after a re-arm: publish engine availability only (`capabilities` +
	 * `pipelines` + `sources`). No session reconcile, cleanup or restoration.
	 */
	publishEngineAvailability: (alive: () => boolean) => Promise<void> | void;
	/**
	 * Push the unavailable capability snapshot to already-connected clients, once
	 * per outage, so a page that stays open shows the engine as offline instead
	 * of only a page opened afterwards.
	 */
	broadcastEngineOffline: () => void;
	/**
	 * Report the engine reachability edge for the crash/recovered lifecycle
	 * indicator. Gated on `isStreaming` inside the reporter: only a mid-stream
	 * unreachable→reachable transition toasts.
	 */
	reportEngineState: (reachable: boolean, streaming: boolean) => void;
	logger: EngineReconnectLogger;
	random: () => number;
	setTimer: (fn: () => void, ms: number) => TimerHandle;
	clearTimer: (timer: TimerHandle) => void;
	/** Monotonic-enough clock for outage durations and the flap window. */
	now: () => number;
	/** Backoff base; overridable for tests. */
	baseDelayMs: number;
	/** Backoff ceiling (the eventual periodic-recheck cadence); overridable. */
	maxDelayMs: number;
	/** See {@link ENGINE_RECONNECT_FLAP_WINDOW_MS}; overridable for tests. */
	flapWindowMs: number;
	monitorControl?: () => Promise<boolean>;
	reconcileLoss?: (current: () => boolean) => Promise<void>;
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
/** The publishing steps of a heal; each is overridable on its own (tests). */
export interface PublishEngineAvailabilitySteps {
	resolveHardware: (current: () => boolean) => Promise<unknown>;
	broadcastCapabilities: () => void;
	broadcastPipelines: () => void;
	refreshSources: (
		deps: EngineDeviceCacheDeps | undefined,
		alive: () => boolean,
	) => Promise<unknown>;
}

const DEFAULT_PUBLISH_STEPS: PublishEngineAvailabilitySteps = {
	resolveHardware: (current) => getHardwareKind({}, current),
	broadcastCapabilities: () =>
		broadcastMsg("capabilities", getLastCapabilities()),
	broadcastPipelines: () => broadcastMsg("pipelines", getPipelinesMessage()),
	// The guard reaches the helper, so a teardown during the device probe
	// neither commits the cache nor broadcasts `sources`.
	refreshSources: (deps, alive) => refreshAndBroadcastSources(deps, alive),
};

export function buildDefaultPublishEngineAvailability(
	sourcesOverride: EngineDeviceCacheDeps | undefined,
	overrides: Partial<PublishEngineAvailabilitySteps> = {},
): (alive: () => boolean) => Promise<void> {
	const steps = { ...DEFAULT_PUBLISH_STEPS, ...overrides };
	return async (alive) => {
		// Ordering is load-bearing: re-resolve the hardware kind BEFORE the
		// pipelines/sources broadcasts, which read the freshly-cached kind live via
		// getEffectiveHardware(). The engine is reachable again, so its
		// platform.hardware_kind now supersedes any boot-time fallback.
		await steps.resolveHardware(alive);
		if (!alive()) return;
		steps.broadcastCapabilities();
		steps.broadcastPipelines();
		await steps.refreshSources(sourcesOverride, alive);
	};
}

function buildDefaultBroadcastEngineState(
	sourcesOverride: EngineDeviceCacheDeps | undefined,
): (alive: () => boolean) => Promise<void> {
	const publish = buildDefaultPublishEngineAvailability(sourcesOverride);
	return async (alive) => {
		await publish(alive);
		if (!alive()) return;
		if (sourcesOverride === undefined) {
			await reconcileStreamSession(alive);
			if (!alive()) return;
			// The engine just became reachable, which is exactly the moment a
			// marker that DEFERRED at boot (no decisive engine answer yet) can be
			// re-judged. Fire-and-forget: the heal broadcast above must settle on
			// its own schedule, and the reconciliation is self-serialising, so a
			// loop that re-fires can never double-apply.
			void runInflightConfigChangeReconciliation();
			// The boot-race half of restoration: an engine that was still down when
			// this process started could not be asked anything at boot. Same
			// fire-and-forget, self-serialising posture as the line above.
			void runStreamRestoration();
		}
	};
}

function defaultDeps(
	fetchers: EngineConnectionOverrides = {},
): EngineReconnectDeps {
	const capsOverride = fetchers.capabilities ?? {};
	return {
		onUnavailable: () => {
			if (!getIsStreaming()) {
				try {
					emitEvent("engine_lost", { streaming: false });
				} catch {
					// Event history must not alter stream control.
				}
			}
		},
		onRecovered: (streaming) => {
			if (!streaming) reportEngineRecovery(streaming);
		},
		refreshCapabilities: (current) => initPipelines(capsOverride, current),
		isEngineReachable: () => getLastCapabilities()?.engineUnavailable === false,
		broadcastEngineState: buildDefaultBroadcastEngineState(fetchers.sources),
		publishEngineAvailability: buildDefaultPublishEngineAvailability(
			fetchers.sources,
		),
		broadcastEngineOffline: () =>
			broadcastMsg("capabilities", getLastCapabilities()),
		reportEngineState: (reachable, streaming) =>
			reportEngineState({ isStreaming: streaming, reachable }),
		logger: defaultLogger,
		random: Math.random,
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (timer) => clearTimeout(timer),
		now: () => performance.now(),
		baseDelayMs: ENGINE_RECONNECT_BASE_MS,
		maxDelayMs: ENGINE_RECONNECT_MAX_MS,
		flapWindowMs: ENGINE_RECONNECT_FLAP_WINDOW_MS,
		...(fetchers.sources === undefined
			? {
					monitorControl: async () =>
						(await getStreamingBackend().probeEngine(true)).status !==
						"unreachable",
					reconcileLoss: reconcileLostStreamSession,
				}
			: {}),
	};
}

interface ReconnectState {
	deps: EngineReconnectDeps;
	attempt: number;
	timer: TimerHandle | undefined;
	/** True once the engine answered and clients were updated (until a re-arm). */
	stopped: boolean;
	/** Tail of the in-flight background attempt (test seam via settleEngineReconnect). */
	inflight: Promise<void>;
	/** When the current outage was first noticed; undefined while settled. */
	lostAt: number | undefined;
	/** When the loop last settled on a reachable engine. */
	healedAt: number | undefined;
	/**
	 * A loss reported while an attempt was already running. The attempt may have
	 * read the engine before it went away, so it must not settle on that answer.
	 */
	lossDuringAttempt: boolean;
	attemptId: symbol;
	/** The offline snapshot went out for the current outage. */
	offlineAnnounced: boolean;
	/** The running loop was started by a re-arm (heal publishes only). */
	rearmed: boolean;
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
async function runAttempt(
	owner: ReconnectState,
	broadcastOnHeal: boolean,
): Promise<boolean> {
	// False once this loop is torn down (or replaced): nothing after that point
	// may touch clients, the session or the indicators.
	const alive = () => state === owner;
	const { deps } = owner;
	const attemptId = Symbol();
	owner.attemptId = attemptId;
	const current = () => alive() && owner.attemptId === attemptId;
	try {
		await deps.refreshCapabilities(current);
	} catch (err) {
		// The capability ladder never throws; defend anyway so a future change
		// can't silently kill the recovery loop.
		deps.logger.warn(
			`engine reconnect: capability refresh threw: ${errMessage(err)}`,
		);
	}
	if (!alive()) return false;
	// A loss reported since this attempt started makes its answer stale: report
	// and publish nothing, and let the next recheck ask again. A Start that could
	// not reach the engine leaves the snapshot as it was, so the refresh may have
	// stored a stale "available" that a page connecting now would read; the next
	// recheck that finds the engine gone tells clients again.
	if (owner.lossDuringAttempt) {
		if (deps.isEngineReachable()) owner.offlineAnnounced = false;
		return false;
	}
	const reachable = deps.isEngineReachable();
	if (reachable) owner.offlineAnnounced = false;
	const streaming = getIsStreaming();
	if (!reachable || !broadcastOnHeal) {
		deps.reportEngineState(reachable, streaming);
		return reachable;
	}
	try {
		await (owner.rearmed
			? deps.publishEngineAvailability(current)
			: deps.broadcastEngineState(current));
		if (owner.rearmed && current()) await deps.reconcileLoss?.(current);
		if (!alive()) return false;
		// Lost again while publishing: the steps after the loss were skipped,
		// and the caller reschedules instead of settling.
		if (owner.lossDuringAttempt) return true;
		deps.logger.info(
			"engine reconnect: engine reachable again; re-broadcast capabilities/pipelines/sources to clients",
		);
		// Reconciliation may adopt or retire a stream; both observers own this snapshot.
		deps.reportEngineState(reachable, streaming);
		deps.onRecovered?.(streaming);
		return true;
	} catch (err) {
		deps.logger.warn(
			`engine reconnect: heal broadcast failed, will retry: ${errMessage(err)}`,
		);
		return false;
	}
}

/**
 * Tell connected clients the engine is offline, once per outage (again after a
 * stale available snapshot, see `runAttempt`).
 */
function announceOffline(): void {
	const owner = state;
	if (!owner || owner.offlineAnnounced || owner.deps.isEngineReachable())
		return;
	try {
		owner.deps.broadcastEngineOffline();
		owner.offlineAnnounced = true;
	} catch (err) {
		owner.deps.logger.warn(
			`engine reconnect: offline broadcast failed: ${errMessage(err)}`,
		);
	}
}

/**
 * Schedule the next background recheck (single in-flight timer; never stacked).
 * No-op once the loop has settled or been torn down.
 */
function scheduleRecheck(): void {
	if (!state || state.stopped || state.timer !== undefined) return;
	const owner = state;
	const { deps } = owner;
	const delay = backoffDelay(
		state.attempt,
		deps.baseDelayMs,
		deps.maxDelayMs,
		deps.random,
	);
	const capped = deps.baseDelayMs * 2 ** state.attempt >= deps.maxDelayMs;
	const firstCapped =
		capped && deps.baseDelayMs * 2 ** (state.attempt - 1) < deps.maxDelayMs;
	state.attempt += 1;
	const message = `engine reconnect: rechecking engine in ${Math.round(delay)}ms (attempt ${state.attempt})`;
	// Once the backoff is capped the cadence no longer changes: say so once,
	// then keep the per-recheck line at debug so a long outage does not log
	// about 120 info lines an hour.
	if (!capped) deps.logger.info(message);
	else if (firstCapped)
		deps.logger.info(
			`${message}; rechecking about every ${Math.round(deps.maxDelayMs / 1000)}s until it answers`,
		);
	else deps.logger.debug?.(message);
	state.timer = deps.setTimer(() => {
		if (state !== owner) return;
		owner.timer = undefined;
		owner.inflight = tickRecheck();
	}, delay);
}

function monitorSettledEngine(owner: ReconnectState): void {
	const { deps } = owner;
	const probe = deps.monitorControl;
	if (
		probe === undefined ||
		state !== owner ||
		!owner.stopped ||
		owner.timer !== undefined
	)
		return;
	const attemptId = owner.attemptId;
	const current = () => state === owner && owner.attemptId === attemptId;
	owner.timer = deps.setTimer(() => {
		if (!current()) return;
		owner.timer = undefined;
		owner.inflight = (async () => {
			const responding = await probe();
			if (!current()) return;
			if (responding) await deps.reconcileLoss?.(current);
			else noteEngineControlLoss("control-liveness");
			if (current()) monitorSettledEngine(owner);
		})().catch((error: unknown) => {
			if (!(error instanceof Error)) throw error;
			deps.logger.warn(
				`engine reconnect: control observation failed: ${error.message}`,
			);
			if (current()) monitorSettledEngine(owner);
		});
	}, ENGINE_CONTROL_LIVENESS_MS);
	owner.timer.unref?.();
}

/**
 * One background recheck tick: attempt, then either settle (engine healed AND
 * clients re-broadcast) or schedule the next recheck (still down, or the heal
 * broadcast threw). Settling is gated on `runAttempt`'s result — a reachable
 * engine whose broadcast throws does NOT settle, it reschedules — so clients are
 * never left on the offline banner while the loop silently gives up.
 */
async function tickRecheck(): Promise<void> {
	const owner = state;
	if (!owner || owner.stopped) return;
	owner.lossDuringAttempt = false;
	const healed = await runAttempt(owner, true);
	if (state !== owner || owner.stopped) return;
	if (healed && !state.lossDuringAttempt) {
		// Healed and clients are updated; settle until the next proven loss.
		const { deps } = state;
		const now = deps.now();
		if (state.lostAt !== undefined)
			deps.logger.info(
				`engine reconnect: engine back after ${Math.round((now - state.lostAt) / 1000)}s; reconnect loop settled`,
			);
		state.stopped = true;
		state.timer = undefined;
		state.lostAt = undefined;
		state.healedAt = now;
		state.offlineAnnounced = false;
		monitorSettledEngine(owner);
		return;
	}
	if (healed) {
		// The heal broadcast already told clients the engine was back.
		state.deps.logger.warn(
			"engine reconnect: engine connection lost again during the recheck; rechecking",
		);
		state.lossDuringAttempt = false;
		state.offlineAnnounced = false;
	}
	announceOffline();
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
	if (
		(depOverrides.refreshCapabilities !== undefined ||
			depOverrides.broadcastEngineState !== undefined) &&
		depOverrides.monitorControl === undefined
	)
		delete deps.monitorControl;
	if (
		depOverrides.publishEngineAvailability !== undefined &&
		depOverrides.reconcileLoss === undefined
	)
		delete deps.reconcileLoss;

	stopEngineReconnect();
	const owner: ReconnectState = {
		deps,
		attempt: 0,
		timer: undefined,
		stopped: false,
		inflight: Promise.resolve(),
		lostAt: undefined,
		healedAt: undefined,
		lossDuringAttempt: false,
		attemptId: Symbol(),
		offlineAnnounced: false,
		rearmed: false,
	};
	state = owner;
	bindEngineRecoveryShutdown(stopEngineReconnect);
	bindEngineControlLoss((site, proven) => {
		if (proven) noteEngineControlLoss(site);
		else rearmEngineReconnect(site);
	});

	// First attempt is awaited (no heal broadcast — there are no clients yet at
	// boot, and boot's own snapshot/sources steps run right after).
	await runAttempt(owner, false);

	if (state !== owner) return;
	if (deps.isEngineReachable() && !state.lossDuringAttempt) {
		deps.logger.info("engine reconnect: engine reachable at boot");
		state.stopped = true;
		state.healedAt = deps.now();
		monitorSettledEngine(owner);
		return;
	}

	deps.logger.warn(
		"engine reconnect: engine unreachable at boot; scheduling background reconnect",
	);
	state.lostAt = deps.now();
	deps.onUnavailable?.();
	scheduleRecheck();
}

/**
 * Start the reconnect loop again after a PROVEN loss of the engine connection
 * once boot is over (`site` names the call that found it). The caller has
 * already invalidated or failed to refresh the capability snapshot; this makes
 * sure something keeps asking until the engine answers, re-broadcasts the
 * healed state and settles again.
 *
 * Idempotent: a loop that is already running keeps its schedule (the loss is
 * remembered so an attempt in flight neither publishes nor settles on a stale
 * answer). A no-op
 * before `initEngineConnection` and after `stopEngineReconnect`, so it never
 * starts work during shutdown.
 */
export function rearmEngineReconnect(site: string): void {
	if (!state) return;
	const { deps } = state;
	state.attemptId = Symbol();
	if (!state.stopped) {
		state.lossDuringAttempt = true;
		return;
	}
	const now = deps.now();
	// Only a heal that followed rechecks is a flap; a boot connect has no
	// backoff to keep.
	const flapping =
		state.attempt > 0 &&
		state.healedAt !== undefined &&
		now - state.healedAt < deps.flapWindowMs;
	if (!flapping) state.attempt = 0;
	if (state.timer !== undefined) deps.clearTimer(state.timer);
	state.timer = undefined;
	state.stopped = false;
	state.rearmed = true;
	state.lostAt = now;
	state.lossDuringAttempt = false;
	state.offlineAnnounced = false;
	deps.logger.warn(
		`engine reconnect: engine connection lost (${site}); reconnecting${flapping ? " with the previous backoff (lost again soon after it came back)" : ""}`,
	);
	announceOffline();
	scheduleRecheck();
}

export function noteEngineControlLoss(site: string): void {
	if (state === undefined) return;
	if (
		!state.stopped &&
		!state.deps.isEngineReachable() &&
		(site === "get-capabilities" || site === "list-devices")
	)
		return;
	invalidateCapabilities();
	rearmEngineReconnect(site);
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
	bindEngineRecoveryShutdown();
	bindEngineControlLoss();
	if (!state) return;
	if (state.timer !== undefined) {
		state.deps.clearTimer(state.timer);
	}
	state.stopped = true;
	state = undefined;
}
