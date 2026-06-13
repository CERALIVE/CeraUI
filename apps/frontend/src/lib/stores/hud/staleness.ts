/**
 * HUD staleness primitives — pure, rune-free.
 *
 * Houses the global staleness threshold helpers, the per-interface freshness
 * fingerprint tracking, the clock-gating predicates, and the self-gating
 * {@link createStalenessClock}. All rune-free so the gating is fully unit-testable
 * under plain vitest with fake timers; the reactive store layers runes on top.
 */

import type { ModemList, NetifMessage, WifiStatus } from "@ceraui/rpc/schemas";
import { CLOCK_INTERVAL_MS, STALE_THRESHOLD_MS } from "./constants";

/** A timestamp is stale when it exists and is older than {@link STALE_THRESHOLD_MS}. Exported so components share the one global threshold. */
export function isTimestampStale(ts: number | null, now: number): boolean {
	if (ts == null) return false;
	return now - ts >= STALE_THRESHOLD_MS;
}

// ============================================
// Per-interface staleness (rune-free, unit-testable)
// ============================================

/** Last-seen content fingerprint + the time it last changed, per interface. */
export interface InterfaceFreshness {
	fingerprint: string;
	lastChangedAt: number;
}

export type InterfaceFreshnessMap = Map<string, InterfaceFreshness>;

/**
 * Fingerprint each interface's *telemetry-bearing* fields, keyed by `ifname`
 * (the join key shared by modems, wifi and netif). A whole-source push refreshes
 * every interface's object reference, so reference identity cannot tell which
 * single interface actually got new data; the content fingerprint can. Modem,
 * wifi and netif parts for the same ifname are concatenated so a fresh push from
 * ANY source counts as that interface updating.
 */
export function interfaceFingerprints(
	modems: ModemList | undefined,
	wifi: WifiStatus | undefined,
	netif: NetifMessage | undefined,
): Map<string, string> {
	const fingerprints = new Map<string, string>();
	const append = (id: string, part: string): void => {
		fingerprints.set(id, (fingerprints.get(id) ?? "") + part);
	};

	for (const [key, modem] of Object.entries(modems ?? {})) {
		append(
			modem.ifname || key,
			`m${JSON.stringify([
				modem.status?.signal ?? null,
				modem.status?.connection ?? null,
				modem.status?.network ?? null,
				modem.no_sim ?? false,
			])}`,
		);
	}

	for (const [key, iface] of Object.entries(wifi ?? {})) {
		const active = iface.available?.find((network) => network.active);
		append(
			iface.ifname || key,
			`w${JSON.stringify([
				iface.conn ?? null,
				active?.ssid ?? null,
				active?.signal ?? null,
			])}`,
		);
	}

	for (const [name, entry] of Object.entries(netif ?? {})) {
		append(
			name,
			`n${JSON.stringify([entry.tp, entry.enabled, entry.ip ?? null])}`,
		);
	}

	return fingerprints;
}

/**
 * Advance the per-interface freshness map: an interface whose fingerprint is
 * unchanged keeps its `lastChangedAt`, a new or changed one is stamped `now`,
 * and an interface no longer present is dropped. Pure: returns a fresh map.
 */
export function trackInterfaceFreshness(
	previous: InterfaceFreshnessMap,
	fingerprints: Map<string, string>,
	now: number,
): InterfaceFreshnessMap {
	const next: InterfaceFreshnessMap = new Map();
	for (const [id, fingerprint] of fingerprints) {
		const prior = previous.get(id);
		next.set(
			id,
			prior && prior.fingerprint === fingerprint
				? prior
				: { fingerprint, lastChangedAt: now },
		);
	}
	return next;
}

/**
 * The set of interface ids whose own data aged past {@link STALE_THRESHOLD_MS}.
 * Reuses the one global threshold; introduces none of its own.
 */
export function staleInterfaceIds(
	freshness: InterfaceFreshnessMap,
	now: number,
): Set<string> {
	const stale = new Set<string>();
	for (const [id, { lastChangedAt }] of freshness) {
		if (now - lastChangedAt >= STALE_THRESHOLD_MS) stale.add(id);
	}
	return stale;
}

/**
 * Whether the staleness clock needs to keep ticking. The clock only advances
 * `now` so a staleness flag can flip; once nothing can transition, ticking is
 * waste — a foot-gun on an always-foreground kiosk with no `visibilitychange`
 * relief. A tick is needed while `streaming`, or while a dropped link is still
 * inside the {@link STALE_THRESHOLD_MS} window counting toward `isFullyStale`.
 *
 * `connectionLostAt` is the one timestamp safe to gate on: set once on
 * disconnect and never refreshed, it ages out deterministically. Refresh-driven
 * sources (sensors/modems/wifi) are intentionally excluded — gating on them
 * would keep an idle-connected device awake forever (the wakeup we remove); their
 * staleness still resolves while streaming, and `isFullyStale` covers disconnect.
 */
export function isClockTickNeeded(
	streaming: boolean,
	connectionLostAt: number | null,
	now: number,
): boolean {
	if (streaming) return true;
	return (
		connectionLostAt != null && now - connectionLostAt < STALE_THRESHOLD_MS
	);
}

/**
 * The full clock gate: tick only when the document is visible AND a tick is
 * actually {@link isClockTickNeeded | needed}. A hidden document never ticks,
 * even mid-stream — there is no one watching for data to go stale.
 */
export function shouldClockRun(
	visible: boolean,
	streaming: boolean,
	connectionLostAt: number | null,
	now: number,
): boolean {
	return visible && isClockTickNeeded(streaming, connectionLostAt, now);
}

// ============================================
// Staleness clock (rune-free, gated)
// ============================================

export interface StalenessClock {
	/** Re-evaluate the gate and start/stop the interval to match. */
	sync(): void;
	/** Whether the interval is currently running. */
	isRunning(): boolean;
	/** Stop the interval and dispose. */
	stop(): void;
}

/**
 * A self-gating staleness clock. Unlike a bare {@link setInterval} it only runs
 * while `shouldRun()` holds: {@link StalenessClock.sync} starts or stops it on
 * demand, and each tick re-checks `shouldRun()` so the interval stops itself the
 * instant the staleness window elapses. Rune-free so the gating is unit-testable
 * under plain vitest with fake timers.
 */
export function createStalenessClock(
	shouldRun: () => boolean,
	onTick: () => void,
	intervalMs: number = CLOCK_INTERVAL_MS,
): StalenessClock {
	let handle: ReturnType<typeof setInterval> | null = null;

	const stop = (): void => {
		if (handle !== null) {
			clearInterval(handle);
			handle = null;
		}
	};

	const start = (): void => {
		if (handle !== null) return;
		handle = setInterval(() => {
			onTick();
			if (!shouldRun()) stop();
		}, intervalMs);
	};

	return {
		sync: () => {
			if (shouldRun()) start();
			else stop();
		},
		isRunning: () => handle !== null,
		stop,
	};
}
