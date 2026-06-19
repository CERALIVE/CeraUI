/*
    CeraUI - web UI for the CeraLive project
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

/*
    TRANSITIONAL — superseded by cerastream structured IPC (plan Task 32).

    srtla_send link telemetry ingestion (ADR-001 consumer side).

    srtla_send publishes a per-uplink JSON snapshot to its --stats-file every
    1000 ms (atomic rename, never torn). This module consumes that file via the
    binding's `watchTelemetry` and folds it into the WebSocket `status` flow as a
    `linkTelemetry` field. It owns three responsibilities:

      1. conn_id -> interface-name mapping. srtla_send assigns each link a stable
         `tlm_id` (stringified as `conn_id`) in source-IP-file order on first
         appearance, monotonically, reset only when the process restarts. CeraUI
         WROTE that file, so it is the ONLY component that can turn a numeric
         conn_id back into a human interface name. We mirror srtla's assignment
         exactly (see `registerSrtlaIpList`).

      2. Watch lifecycle. `startLinkTelemetry` begins polling when srtla_send
         spawns; `stopLinkTelemetry` halts it (and clears the registry, mirroring
         the process-restart id reset) when the stream stops.

      3. State derivation. Three observable states, matching the task contract:
           - srtla_send not running         -> linkTelemetry: null
           - running, last read failed/stale -> links flagged `stale: true`
           - running, fresh read             -> values populated, `stale: false`
*/

import {
	senderTelemetryPath,
	type Telemetry,
	type WatchTelemetryHandle,
	watchTelemetry,
} from "@ceralive/srtla-send/telemetry";
import { logger } from "../../helpers/logger.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import {
	IFACE_RESOLVER_MAX_RETRIES,
	IFACE_RESOLVER_RETRY_DELAY_MS,
	SRTLA_LISTEN_PORT,
} from "./constants.ts";

// srtla_send listens for the local SRT encoder on this port; the stats file path
// is derived from it (mirrors the receiver's /tmp/srtla-group-<PORT> convention).

/** Canonical stats-file path passed to srtla_send `--stats-file` and read back. */
export function srtlaStatsFile(listenPort: number = SRTLA_LISTEN_PORT): string {
	return senderTelemetryPath(listenPort);
}

/** One per-link row surfaced to the UI via the WS status message. */
export interface LinkTelemetryEntry {
	conn_id: string;
	/** Human interface name resolved from the backend-owned IP list. */
	iface: string;
	rtt_ms: number;
	nak_count: number;
	weight_percent: number;
	/** True when the underlying snapshot is stale/absent but links are known. */
	stale: boolean;
}

export interface LinkTelemetryMessage {
	links: Array<LinkTelemetryEntry>;
	/**
	 * CeraUI-side wall-clock ms of the last SUCCESSFUL read — derived here, not
	 * from the frozen srtla snapshot. Advances on a fresh tick, freezes when reads
	 * go stale/absent, so the UI has an explicit staleness clock.
	 */
	lastReadMs: number;
}

// ---------------------------------------------------------------------------
// conn_id <-> interface mapping
// ---------------------------------------------------------------------------

// Mirrors srtla_send's `next_tlm_id` / per-link `tlm_id` assignment (sender.cpp).
// Ids are assigned in source-IP-file order on first appearance, kept across
// SIGHUP reloads for IPs that persist, and a NEW id is minted for a genuinely
// new IP. Removed IPs are pruned (so a later re-add mints a fresh id, exactly
// as srtla frees and re-creates the conn). The counter only resets when the
// srtla_send process restarts — modeled here by clearing on stopLinkTelemetry.
let connIdToIp = new Map<number, string>();
let ipToConnId = new Map<string, number>();
let nextConnId = 0;

/** Dedup preserving first-appearance order (mirrors setup_conns dedup-by-src). */
function dedupInOrder(ips: Array<string>): Array<string> {
	const seen = new Set<string>();
	const out: Array<string> = [];
	for (const raw of ips) {
		const ip = raw.trim();
		if (!ip || seen.has(ip)) continue;
		seen.add(ip);
		out.push(ip);
	}
	return out;
}

/**
 * Fold a written source-IP list into the conn_id registry, mirroring srtla's
 * monotonic tlm_id assignment so a later telemetry `conn_id` maps back to the
 * correct interface. Call this whenever the IP list is (re)written.
 */
export function registerSrtlaIpList(ips: Array<string>): void {
	const ordered = dedupInOrder(ips);

	for (const ip of ordered) {
		if (!ipToConnId.has(ip)) {
			const id = nextConnId++;
			ipToConnId.set(ip, id);
			connIdToIp.set(id, ip);
		}
	}

	// Prune IPs no longer present (srtla frees the removed conn). Their ids are
	// not reused; a re-add mints the next monotonic id.
	const keep = new Set(ordered);
	for (const [ip, id] of [...ipToConnId.entries()]) {
		if (!keep.has(ip)) {
			ipToConnId.delete(ip);
			connIdToIp.delete(id);
		}
	}
}

function resetConnIdRegistry(): void {
	connIdToIp = new Map();
	ipToConnId = new Map();
	nextConnId = 0;
}

/** IP currently mapped to a stringified conn_id, or undefined if unknown. */
export function ipForConnId(connId: string): string | undefined {
	const id = Number(connId);
	if (!Number.isInteger(id)) return undefined;
	return connIdToIp.get(id);
}

// Interface-name resolver: IP -> human interface name. Injected so tests do not
// need the full network-interfaces graph (mirrors health.ts's test override).
type IfaceResolver = (ip: string) => string | undefined;

let defaultIfaceResolver: IfaceResolver | null = null;

/** Lazy import keeps the network module out of the test-import graph. */
async function importDefaultResolver(): Promise<IfaceResolver> {
	const { getNetworkInterfaces } = await import(
		"../network/network-interfaces.ts"
	);
	return (ip: string): string | undefined => {
		const netif = getNetworkInterfaces();
		for (const name in netif) {
			if (netif[name]?.ip === ip) return name;
		}
		return undefined;
	};
}

type ResolverLoader = () => Promise<IfaceResolver>;

let resolverLoaderOverride: ResolverLoader | null = null;

/** Test seam: replace the resolver loader (null restores the lazy import).
 *  Also clears the cached resolver so each test re-loads from a clean slate. */
export function setResolverLoaderForTest(fn: ResolverLoader | null): void {
	resolverLoaderOverride = fn;
	defaultIfaceResolver = null;
}

async function loadDefaultIfaceResolver(): Promise<IfaceResolver> {
	if (defaultIfaceResolver) return defaultIfaceResolver;
	const loader = resolverLoaderOverride ?? importDefaultResolver;
	defaultIfaceResolver = await loader();
	return defaultIfaceResolver;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load the default iface resolver, retrying a transient failure (the network
 * module not yet importable at spawn) before giving up. Each failed attempt
 * logs at debug; exhausting all attempts logs one warn — the conn_id/IP
 * fallback still keeps the telemetry `iface` field populated, so this only
 * degrades the human-readable name, never the link rows.
 *
 * Returns true once the resolver is loaded, false if every attempt failed.
 * The delay source is injectable so the retry is unit-testable without waiting.
 */
export async function loadDefaultIfaceResolverWithRetry(
	maxRetries: number = IFACE_RESOLVER_MAX_RETRIES,
	delayMs: number = IFACE_RESOLVER_RETRY_DELAY_MS,
	delay: (ms: number) => Promise<void> = sleep,
): Promise<boolean> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await loadDefaultIfaceResolver();
			return true;
		} catch (err) {
			logger.debug("link-telemetry: iface resolver load failed", {
				attempt,
				maxRetries,
				err,
			});
			if (attempt < maxRetries) await delay(delayMs);
		}
	}
	logger.warn(
		"link-telemetry: iface resolver unavailable after retries; using IP/conn_id fallback",
		{ maxRetries },
	);
	return false;
}

let ifaceResolverOverride: IfaceResolver | null = null;

/** Test seam: override the IP -> interface-name resolver (null clears it). */
export function setIfaceResolverForTest(fn: IfaceResolver | null): void {
	ifaceResolverOverride = fn;
}

function resolveIface(connId: string): string {
	const ip = ipForConnId(connId);
	const resolver = ifaceResolverOverride ?? defaultIfaceResolver;
	const name = ip && resolver ? resolver(ip) : undefined;
	// Fall back to the raw IP, then the conn_id, so the field is never empty.
	return name ?? ip ?? `link-${connId}`;
}

// ---------------------------------------------------------------------------
// Watch lifecycle + snapshot state
// ---------------------------------------------------------------------------

let handle: WatchTelemetryHandle | null = null;
// Last FRESH (non-null) snapshot, retained so a subsequent stale/absent read can
// still surface the known links flagged `stale: true`.
let lastSnapshot: Telemetry | null = null;
// Whether the most recent watch tick delivered fresh data. False => stale/absent.
let lastTickFresh = false;
// CeraUI-side wall-clock ms of the last successful (non-null) read; 0 until one.
let lastReadMs = 0;

let nowFn: () => number = Date.now;

/** Test seam: pin the staleness clock (null restores Date.now). */
export function setTelemetryClockForTest(fn: (() => number) | null): void {
	nowFn = fn ?? Date.now;
}

export interface StartLinkTelemetryOptions {
	intervalMs?: number;
	/** Test seam: inject a fake watch implementation. */
	watch?: typeof watchTelemetry;
}

/**
 * Ingest one watch tick. `watchTelemetry` already collapses absent / unparseable
 * / stale (> 5000 ms) reads to `null`, so a `null` here while watching means the
 * snapshot went stale or vanished.
 */
function ingestTelemetry(telemetry: Telemetry | null): void {
	if (telemetry) {
		lastSnapshot = telemetry;
		lastTickFresh = true;
		lastReadMs = nowFn();
	} else {
		lastTickFresh = false;
	}
}

/** Test seam: feed a snapshot as if a watch tick fired. */
export function ingestTelemetryForTest(telemetry: Telemetry | null): void {
	ingestTelemetry(telemetry);
}

/**
 * Begin consuming the stats file. Re-seeds the conn_id registry from the IP list
 * srtla_send will read at spawn (file order == tlm_id order), then polls the
 * stats file. Idempotent: an existing watcher is stopped first.
 */
export function startLinkTelemetry(
	statsFile: string,
	initialIps: Array<string>,
	opts: StartLinkTelemetryOptions = {},
): void {
	if (handle) {
		handle.stop();
		handle = null;
	}

	// Fresh process == fresh tlm_id sequence; seed from the spawn-time IP list.
	resetConnIdRegistry();
	registerSrtlaIpList(initialIps);

	lastSnapshot = null;
	lastTickFresh = false;
	lastReadMs = 0;

	// Resolve the default interface resolver eagerly (best-effort) so live reads
	// can map conn_id -> iface without awaiting inside the broadcast path. Skip
	// when a test override is active to avoid pulling the network graph.
	if (!ifaceResolverOverride) {
		void loadDefaultIfaceResolverWithRetry();
	}

	const watch = opts.watch ?? watchTelemetry;
	const watchOpts =
		opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {};
	// watchTelemetry's callback gets a TelemetryUpdate ({ data, stale }), not a raw
	// snapshot — collapse stale ticks to null so ingestTelemetry caches correctly.
	handle = watch(
		statsFile,
		(update) => ingestTelemetry(update.stale ? null : update.data),
		watchOpts,
	);
}

/** Stop consuming the stats file and clear the conn_id registry (process reset). */
export function stopLinkTelemetry(): void {
	if (handle) {
		handle.stop();
		handle = null;
	}
	lastSnapshot = null;
	lastTickFresh = false;
	lastReadMs = 0;
	resetConnIdRegistry();
}

export function isLinkTelemetryActive(): boolean {
	return handle !== null;
}

/**
 * Derive the WS `linkTelemetry` payload.
 *
 *   - not watching (srtla_send not running)      -> null
 *   - watching, never received a fresh snapshot   -> null (telemetry unavailable)
 *   - watching, last tick stale/absent (cached)   -> cached links, stale: true
 *   - watching, fresh snapshot                    -> live links, stale: false
 */
export function buildLinkTelemetry(): LinkTelemetryMessage | null {
	if (!handle) return null;
	if (lastSnapshot === null) return null;

	const stale = !lastTickFresh;
	return {
		links: lastSnapshot.connections.map((c) => ({
			conn_id: c.conn_id,
			iface: resolveIface(c.conn_id),
			rtt_ms: c.rtt_ms,
			nak_count: c.nak_count,
			weight_percent: c.weight_percent,
			stale,
		})),
		lastReadMs,
	};
}

let lastBroadcastJson: string | null = null;

export function resetLinkTelemetryBroadcastState(): void {
	lastBroadcastJson = null;
}

/**
 * Push a `status` message carrying the latest `linkTelemetry` only when it
 * changes, on the shared heartbeat tick (mirrors broadcastHealthIfChanged).
 * Folds into the existing status flow — no new endpoint.
 */
export function broadcastLinkTelemetryIfChanged(): LinkTelemetryMessage | null {
	const payload = buildLinkTelemetry();
	const json = JSON.stringify(payload);
	if (json !== lastBroadcastJson) {
		lastBroadcastJson = json;
		broadcastMsg("status", { linkTelemetry: payload });
	}
	return payload;
}
