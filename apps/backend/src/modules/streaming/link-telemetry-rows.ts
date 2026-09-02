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
  PROJECTING ONE TELEMETRY CONNECTION ONTO ONE RENDERED ROW.

  Extracted from `link-telemetry.ts` so the lifecycle (watch, cutover, staleness)
  and the IDENTITY question stay separable, and so both halves stay under the
  250 pure-LOC ceiling.

  THE RESOLUTION LADDER, strongest rung first. Each rung is a different QUALITY
  of evidence, and collapsing them loses exactly the twin case:

    1. the sender's own `link_id` echo — it is telling us which published row it
       actually bound, so nothing outranks it;
    2. the sender's own `iface` echo — the interface it is egressing through;
    3. the `conn_id` as a `BIND_IPS_FILE` LINE position, but ONLY while a mapping
       is in force. Without one the sender collapses duplicate source IPs, so its
       ids count UNIQUE ADDRESSES rather than lines and the two numberings
       diverge exactly where the twins are;
    4. the legacy `conn_id -> unique-IP order -> interface` registry, which is
       byte-identical to the pre-mapping behaviour.

  Rungs 1 and 2 are LIVE. A retired comment here claimed the pinned
  `@ceralive/srtla-send` build stripped `link_id` and `iface`, so that every
  launch resolved on rung 3 or 4 until the binding was republished. That was
  measured false: `2026.8.0` declares BOTH as optional fields on its published
  `Telemetry` type and parses them at runtime, so the sender's own echo has been
  outranking the file position all along.
*/

import type { Telemetry } from "@ceralive/srtla-send/telemetry";
import type { BondLinkIdentityState } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	IFACE_RESOLVER_MAX_RETRIES,
	IFACE_RESOLVER_RETRY_DELAY_MS,
} from "./constants.ts";
import {
	identityAtLine,
	identityForIface,
	identityForLinkId,
	type LinkIdentity,
} from "./link-registry.ts";

/** One per-link row surfaced to the UI via the WS status message. */
export interface LinkTelemetryEntry {
	/** srtla's own `tlm_id`. A FILE POSITION — never the row's identity. */
	conn_id: string;
	/**
	 * Todo 10's minted per-device id: THE row identity when it is known. Absent
	 * for a link resolved on the legacy `conn_id` rung, and for one whose
	 * identity could not be resolved at all — {@link LinkTelemetryEntry.identity_state}
	 * is what tells those two apart.
	 */
	link_id?: string;
	/**
	 * Emitted ONLY as `"unmappable"`, and only when the writer positively failed
	 * to resolve this link's device. Absence makes no claim either way, which is
	 * the honest reading of a legacy-rung row.
	 */
	identity_state?: BondLinkIdentityState;
	/** Human interface name — the sender's own, or the backend-owned IP list's. */
	iface: string;
	/** Physical port this link's device sits in — what separates two twins. */
	port_label?: string;
	/** Present ONLY when the device reports one. The HiLink twins do not. */
	serial?: string;
	rtt_ms: number;
	nak_count: number;
	weight_percent: number;
	/**
	 * MEASURED wire throughput for this link, bits/s (ADR-001 `bitrate_bps`:
	 * wire bytes × 8, protocol overhead and retransmits included). The only
	 * bitrate on the wire that is an observation rather than a setpoint.
	 */
	bitrate_bps: number;
	/**
	 * Cumulative wire BYTES this uplink has sent this session (srtla_send
	 * ADR-002). Bytes, not bits — no ×8, unlike `bitrate_bps` directly above.
	 * Read straight off the producer's typed optional field: absent means the
	 * SENDER reported none, which is UNKNOWN, never zero.
	 */
	bytes_sent_total?: number;
	/** True when the underlying snapshot is stale/absent but links are known. */
	stale: boolean;
}

export interface LinkTelemetryMessage {
	links: Array<LinkTelemetryEntry>;
	/** Sum of every link's `bitrate_bps` — the bond's measured total, bits/s. */
	measured_bps: number;
	/**
	 * Cumulative wire BYTES the whole bond has sent this session — the operator's
	 * "total transferred" figure. Forwarded VERBATIM from the sender, which keeps
	 * it monotonic across per-link reconnects and IP-list reloads; it is NOT the
	 * sum of `links[].bytes_sent_total`, which regresses when a link is dropped.
	 * Absent means the SENDER reported none: UNKNOWN, never zero.
	 */
	bytes_sent_total?: number;
	/**
	 * CeraUI-side wall-clock ms of the last SUCCESSFUL read — derived here, not
	 * from the frozen srtla snapshot. Advances on a fresh tick, freezes when reads
	 * go stale/absent, so the UI has an explicit staleness clock.
	 */
	lastReadMs: number;
}

// ---------------------------------------------------------------------------
// Legacy conn_id <-> interface mapping (rung 4)
// ---------------------------------------------------------------------------

// Mirrors srtla_send's `next_tlm_id` / per-link `tlm_id` assignment. Ids are
// assigned in source-IP-file order on first appearance, kept across SIGHUP
// reloads for IPs that persist, and a NEW id is minted for a genuinely new IP.
// Removed IPs are pruned (so a later re-add mints a fresh id, exactly as srtla
// frees and re-creates the conn). The counter only resets when the srtla_send
// process restarts — modeled by clearing on stopLinkTelemetry.
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

export function resetConnIdRegistry(): void {
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
	const { dongleSlotLabel } = await import("../network/dongle-metadata.ts");
	return (ip: string): string | undefined => {
		const netif = getNetworkInterfaces();
		for (const name in netif) {
			if (netif[name]?.ip !== ip) continue;
			// A claimed dongle's veth is named `dg<N>h`, which tells an operator
			// nothing. Its own slot label does. Every other interface keeps the
			// unchanged first-IP-match name.
			return dongleSlotLabel(name) ?? name;
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

/** Is the eager resolver load worth attempting for this process? */
export function hasIfaceResolverOverride(): boolean {
	return ifaceResolverOverride !== null;
}

function legacyIface(connId: string): string {
	const ip = ipForConnId(connId);
	const resolver = ifaceResolverOverride ?? defaultIfaceResolver;
	const name = ip && resolver ? resolver(ip) : undefined;
	// Fall back to the raw IP, then the conn_id, so the field is never empty.
	return name ?? ip ?? `link-${connId}`;
}

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

/** Read an additive string field the pinned binding may have stripped. */
function readOptionalString(source: unknown, key: string): string | undefined {
	const value = (source as Record<string, unknown> | null | undefined)?.[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** One unreadable link contributes 0 rather than making the whole sum `NaN`. */
function asMeasuredBps(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function resolveIdentity(
	connId: string,
	conn: unknown,
	mappingActive: boolean,
): LinkIdentity | undefined {
	return (
		identityForLinkId(readOptionalString(conn, "link_id")) ??
		identityForIface(readOptionalString(conn, "iface")) ??
		(mappingActive ? identityAtLine(Number(connId)) : undefined)
	);
}

/**
 * The degraded marker for a row the ladder could not identify.
 *
 * SUPPRESSION-ONLY, and that is the whole safety argument: it can never promote
 * a row to an identity — no `link_id`, no port label, no serial — so the legacy
 * rung's rows stay byte-identical to before. It answers the one question the
 * ladder's silence leaves open ("is this link KNOWN-unidentifiable, or merely
 * unresolved on this rung") from the writer's own record for the interface the
 * row actually resolved to. A resolved entry contributes nothing here.
 */
function unmappableByIface(iface: string): BondLinkIdentityState | undefined {
	return identityForIface(iface)?.identityState === "unmappable"
		? "unmappable"
		: undefined;
}

/**
 * Project one snapshot onto the rendered rows.
 *
 * `mappingActive` comes from the ONE normalized disposition stream — it is never
 * inferred from the telemetry's own shape, because "the field is missing" and
 * "the mapping is not in force" are different facts and only the disposition
 * boundary can tell them apart.
 */
export function buildLinkRows(
	snapshot: Telemetry,
	stale: boolean,
	mappingActive: boolean,
): LinkTelemetryEntry[] {
	return snapshot.connections.map((conn) => {
		const identity = resolveIdentity(conn.conn_id, conn, mappingActive);
		const bytesSentTotal = conn.bytes_sent_total;
		const iface =
			identity?.iface ??
			readOptionalString(conn, "iface") ??
			legacyIface(conn.conn_id);
		const identityState = identity?.identityState ?? unmappableByIface(iface);
		return {
			conn_id: conn.conn_id,
			...(identity?.linkId !== undefined ? { link_id: identity.linkId } : {}),
			...(identityState === "unmappable"
				? { identity_state: identityState }
				: {}),
			iface,
			...(identity?.portLabel !== undefined
				? { port_label: identity.portLabel }
				: {}),
			...(identity?.serial !== undefined ? { serial: identity.serial } : {}),
			rtt_ms: conn.rtt_ms,
			nak_count: conn.nak_count,
			weight_percent: conn.weight_percent,
			bitrate_bps: asMeasuredBps(conn.bitrate_bps),
			...(bytesSentTotal === undefined
				? {}
				: { bytes_sent_total: bytesSentTotal }),
			stale,
		};
	});
}
