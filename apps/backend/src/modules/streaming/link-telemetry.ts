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

      1. Watch lifecycle. `startLinkTelemetry` begins polling when srtla_send
         spawns; `stopLinkTelemetry` halts it (and clears the registries,
         mirroring the process-restart id reset) when the stream stops.

      2. State derivation. Three observable states, matching the task contract:
           - srtla_send not running         -> linkTelemetry: null
           - running, last read failed/stale -> links flagged `stale: true`
           - running, fresh read             -> values populated, `stale: false`

      3. Carrying the ONE normalized bind-map disposition to the UI, and feeding
         the sender's own verdict back into the producer boundary.

    WHO A ROW BELONGS TO is `link-telemetry-rows.ts` (the identity ladder) over
    `link-registry.ts` (what the writer published). Those live apart from the
    lifecycle deliberately: "which physical modem is this" is the question this
    file kept answering wrong when it answered it from a file position.
*/

import {
	type ControlClientOptions,
	createControlClient,
	supportsStatsSubscription,
	type TelemetryControlClient,
} from "@ceraui/srtla-send/control";
import {
	SENDER_TELEMETRY_STALE_MS,
	senderTelemetryPath,
	type Telemetry,
	type WatchTelemetryHandle,
	watchTelemetry,
} from "@ceraui/srtla-send/telemetry";
import { logger } from "../../helpers/logger.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import type { BondEntry } from "./bind-map.ts";
import { onBindMapReportChange } from "./bind-map-disposition.ts";
import { announceBindMapReport } from "./bind-map-notification.ts";
import {
	SRTLA_CONTROL_CONNECT_TIMEOUT_MS,
	SRTLA_LISTEN_PORT,
} from "./constants.ts";
import {
	buildBondMapping,
	ingestSenderBindMapReport,
	isBondMappingActive,
	resetSenderBindMapReport,
} from "./link-mapping-report.ts";
import {
	registerBondIdentities,
	resetBondIdentities,
} from "./link-registry.ts";
import {
	buildLinkRows,
	hasIfaceResolverOverride,
	type LinkTelemetryMessage,
	loadDefaultIfaceResolverWithRetry,
	registerSrtlaIpList,
	resetConnIdRegistry,
} from "./link-telemetry-rows.ts";

export type {
	LinkTelemetryEntry,
	LinkTelemetryMessage,
} from "./link-telemetry-rows.ts";
export {
	ipForConnId,
	loadDefaultIfaceResolverWithRetry,
	registerSrtlaIpList,
	setIfaceResolverForTest,
	setResolverLoaderForTest,
} from "./link-telemetry-rows.ts";

// srtla_send listens for the local SRT encoder on this port; the stats file path
// is derived from it (mirrors the receiver's /tmp/srtla-group-<PORT> convention).

/** Canonical stats-file path passed to srtla_send `--stats-file` and read back. */
export function srtlaStatsFile(listenPort: number = SRTLA_LISTEN_PORT): string {
	return senderTelemetryPath(listenPort);
}

/**
 * Adopt the bond the writer just published.
 *
 * ONE call site (`publishSrtlaBond`) keeps both registries in step with the
 * exact file the sender is about to re-read: the identity registry so a row can
 * be keyed on its device, and the legacy conn_id registry so a launch with no
 * mapping still resolves an interface name.
 */
export function registerSrtlaBond(entries: readonly BondEntry[]): void {
	registerBondIdentities(entries);
	registerSrtlaIpList(entries.map((entry) => entry.ip));
}

// Dev/e2e seam: with no real srtla_send process the real sources never activate,
// so a registered mock provider surfaces plausible per-link telemetry through the
// EXISTING status flow while the mock stream is active (it owns the mock gate and
// the active/idle decision; a non-null return short-circuits the real path).
type MockLinkTelemetryProvider = () => LinkTelemetryMessage | null;

let mockLinkTelemetryProvider: MockLinkTelemetryProvider | null = null;

/** Register (or clear with null) the dev/e2e mock link-telemetry provider. */
export function setMockLinkTelemetryProvider(
	fn: MockLinkTelemetryProvider | null,
): void {
	mockLinkTelemetryProvider = fn;
}

// ---------------------------------------------------------------------------
// Watch lifecycle + snapshot state
// ---------------------------------------------------------------------------

let handle: WatchTelemetryHandle | null = null;
// Last FRESH (non-null) snapshot, retained so a subsequent stale/absent read can
// still surface the known links flagged `stale: true`.
let lastSnapshot: Telemetry | null = null;
// Stats-file snapshots don't carry the sender's connection state.
let observedActiveLinks: number | undefined;
// stats.update is nominally 1 Hz. After a gap, allow one missed push but
// require two timely all-up observations before returning to Healthy.
const HEALTHY_BOND_REACQUIRE_GAP_MS = 2_000;
let healthyBond: { at: number | null; confirmed: boolean } | undefined;
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
	/**
	 * srtla_send JSON-RPC control-socket path. When set, the telemetry source
	 * attempts to cut over from the --stats-file poll to the control-socket
	 * stats subscription; any failure leaves the file-poll running untouched.
	 */
	controlSocket?: string;
}

// Cleanup for the active stats subscription (control-socket cutover). Non-null
// only while telemetry is sourced from the subscription rather than the poll.
let subscriptionCleanup: (() => void) | null = null;
// Cleanup for the disposition subscription: the operator band follows the ONE
// normalized stream for the whole session rather than being re-announced per tick.
let bindMapReportCleanup: (() => void) | null = null;

// Only the three calls the cutover makes, so a test double is three members
// rather than the sender's whole method table. `createControlClient` is
// assignable to this.
type ControlClientFactory = (
	options: ControlClientOptions,
) => Promise<TelemetryControlClient | null>;
let controlClientFactoryOverride: ControlClientFactory | null = null;

/** Test seam: inject a fake control-client factory (null restores the real one). */
export function setControlClientFactoryForTest(
	fn: ControlClientFactory | null,
): void {
	controlClientFactoryOverride = fn;
}

/**
 * Ingest one watch tick. `watchTelemetry` already collapses absent / unparseable
 * / stale (> 5000 ms) reads to `null`, so a `null` here while watching means the
 * snapshot went stale or vanished.
 */
function ingestTelemetry(
	telemetry: Telemetry | null,
	activeLinks?: number,
): void {
	if (telemetry) {
		lastSnapshot = telemetry;
		observedActiveLinks = activeLinks;
		lastTickFresh = true;
		lastReadMs = nowFn();
		if (activeLinks === undefined) {
			if (healthyBond) healthyBond = { at: null, confirmed: false };
		} else if (
			activeLinks > 0 &&
			activeLinks === telemetry.connections.length
		) {
			const gapLimit = healthyBond?.confirmed
				? SENDER_TELEMETRY_STALE_MS
				: HEALTHY_BOND_REACQUIRE_GAP_MS;
			const at = Math.min(lastReadMs, telemetry.last_updated_ms);
			if (healthyBond?.at !== at) {
				healthyBond = {
					at,
					confirmed:
						!healthyBond ||
						(healthyBond.at !== null &&
							at > healthyBond.at &&
							at - healthyBond.at <= gapLimit),
				};
			}
		} else {
			healthyBond = undefined;
		}
		// The sender's own verdict REPLACES the writer's synthesized one, and it
		// is the only half that can observe a degraded reload.
		ingestSenderBindMapReport(telemetry);
	} else {
		lastTickFresh = false;
		if (healthyBond) healthyBond = { at: null, confirmed: false };
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
	if (subscriptionCleanup) {
		subscriptionCleanup();
		subscriptionCleanup = null;
	}
	if (handle) {
		handle.stop();
		handle = null;
	}

	// Fresh process == fresh tlm_id sequence; seed from the spawn-time IP list.
	// The identity registry is NOT reset here: `publishSrtlaBond` filled it with
	// the exact rows this sender is about to read, and it outlives the watcher.
	resetConnIdRegistry();
	registerSrtlaIpList(initialIps);
	resetSenderBindMapReport();

	lastSnapshot = null;
	observedActiveLinks = undefined;
	healthyBond = undefined;
	lastTickFresh = false;
	lastReadMs = 0;

	if (bindMapReportCleanup) bindMapReportCleanup();
	bindMapReportCleanup = onBindMapReportChange(() => {
		announceBindMapReport();
	});

	// Resolve the default interface resolver eagerly (best-effort) so live reads
	// can map conn_id -> iface without awaiting inside the broadcast path. Skip
	// when a test override is active to avoid pulling the network graph.
	if (!hasIfaceResolverOverride()) {
		void loadDefaultIfaceResolverWithRetry();
	}

	const watch = opts.watch ?? watchTelemetry;
	const watchOpts =
		opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {};
	// File-poll is the always-on baseline; the subscription cutover (below) only
	// ever replaces it once the sender confirms the capability, and any failure
	// leaves this watcher running — the airtight fallback.
	startFilePollWatcher(watch, statsFile, watchOpts);

	if (opts.controlSocket) {
		void attemptSubscriptionCutover(
			opts.controlSocket,
			watch,
			statsFile,
			watchOpts,
		);
	}
}

type WatchOpts = { intervalMs?: number };

function startFilePollWatcher(
	watch: typeof watchTelemetry,
	statsFile: string,
	watchOpts: WatchOpts,
): void {
	// watchTelemetry's callback gets a TelemetryUpdate ({ data, stale }), not a raw
	// snapshot — collapse stale ticks to null so ingestTelemetry caches correctly.
	handle = watch(
		statsFile,
		(update) => ingestTelemetry(update.stale ? null : update.data),
		watchOpts,
	);
}

/**
 * Best-effort cutover from file-poll to the control-socket stats subscription.
 *
 * Every exit that is not a confirmed, live subscription leaves the file-poll
 * watcher running (connect failure, probe timeout, capability absent, subscribe
 * error). Only once the sender's own `get_capabilities` document advertises the
 * `subscribe`/`unsubscribe` pair AND the stream is open do we stop the poll and
 * source telemetry from pushed `stats.update` frames. A mid-stream null (parse
 * failure / disconnect) re-arms the file-poll.
 *
 * FEATURE DETECTION IS `get_capabilities`, NOT `hello`. `hello` belonged to the
 * retired npm binding's dialect and does not exist on the hard-forked sender;
 * `get_capabilities` is the same document the pre-spawn `--capabilities-json`
 * probe returns, plus the live `methods` array. A binary that predates the fork
 * answers `-32601`, which the client reports as `null` rather than throwing —
 * "no capability support" is an answer, and this runs on the start path.
 */
async function attemptSubscriptionCutover(
	socketPath: string,
	watch: typeof watchTelemetry,
	statsFile: string,
	watchOpts: WatchOpts,
): Promise<void> {
	try {
		const factory = controlClientFactoryOverride ?? createControlClient;
		const client = await factory({
			socketPath,
			timeoutMs: SRTLA_CONTROL_CONNECT_TIMEOUT_MS,
		});
		if (!client) return;

		const capabilities = await client.getCapabilities().catch(() => null);
		if (!capabilities) {
			logger.debug(
				"link-telemetry: sender reports no capabilities support, staying on file-poll",
			);
			client.close();
			return;
		}
		if (!supportsStatsSubscription(capabilities)) {
			logger.debug(
				"link-telemetry: sender advertises no stats subscription, staying on file-poll",
				{ version: capabilities.version },
			);
			client.close();
			return;
		}

		subscriptionCleanup = client.subscribeStats((snapshot, activeLinks) => {
			if (snapshot === null && !handle) {
				logger.warn(
					"link-telemetry: subscription disconnected, falling back to file-poll",
				);
				startFilePollWatcher(watch, statsFile, watchOpts);
			}
			ingestTelemetry(snapshot, activeLinks);
		});

		// Subscription confirmed live — retire the redundant file-poll.
		if (handle) {
			handle.stop();
			handle = null;
		}
		logger.debug("link-telemetry: switched to JSON-RPC subscription path");
	} catch (err) {
		logger.debug(
			"link-telemetry: subscription cutover failed, staying on file-poll",
			{ err },
		);
	}
}

/** Stop consuming telemetry (poll + subscription) and clear both registries. */
export function stopLinkTelemetry(): void {
	if (subscriptionCleanup) {
		subscriptionCleanup();
		subscriptionCleanup = null;
	}
	if (bindMapReportCleanup) {
		bindMapReportCleanup();
		bindMapReportCleanup = null;
	}
	if (handle) {
		handle.stop();
		handle = null;
	}
	lastSnapshot = null;
	observedActiveLinks = undefined;
	healthyBond = undefined;
	lastTickFresh = false;
	lastReadMs = 0;
	resetConnIdRegistry();
	resetBondIdentities();
	resetSenderBindMapReport();
}

// Telemetry is live while EITHER source feeds it: the file-poll watcher or the
// control-socket subscription (which retires the watcher on cutover).
export function isLinkTelemetryActive(): boolean {
	return handle !== null || subscriptionCleanup !== null;
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
	const mock = mockLinkTelemetryProvider?.();
	if (mock) return mock;

	if (!isLinkTelemetryActive()) return null;
	if (lastSnapshot === null) return null;

	// A silent open socket never supplies the null tick which expires a file read.
	// Check both the delivery and the file timestamp, so rereading a file can't
	// buy extra lifetime past the sender's freshness window.
	const stale =
		!lastTickFresh ||
		nowFn() - Math.min(lastReadMs, lastSnapshot.last_updated_ms) >
			SENDER_TELEMETRY_STALE_MS;
	const links = buildLinkRows(lastSnapshot, stale, isBondMappingActive());
	// Forwarded verbatim, never summed from `links`: the sender's accumulator is
	// what stays monotonic across a reconnect or an IP-list reload.
	const bondBytesSentTotal = lastSnapshot.bytes_sent_total;
	return {
		links,
		...(stale
			? { stale: true }
			: observedActiveLinks === undefined || healthyBond?.confirmed === false
				? {}
				: { active_links: observedActiveLinks }),
		...(links.every((link) => link.bitrate_bps !== undefined)
			? {
					measured_bps: links.reduce(
						(total, link) => total + (link.bitrate_bps ?? 0),
						0,
					),
				}
			: {}),
		...(bondBytesSentTotal === undefined
			? {}
			: { bytes_sent_total: bondBytesSentTotal }),
		lastReadMs,
	};
}

/** One status projection for initial, pulled and heartbeat delivery. */
export function linkTelemetryStatus() {
	const linkTelemetry = buildLinkTelemetry();
	return {
		linkTelemetry,
		link_telemetry_waiting: linkTelemetry === null && isLinkTelemetryActive(),
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
	const telemetry = linkTelemetryStatus();
	const bondMapping = buildBondMapping();
	const json = JSON.stringify({ ...telemetry, bondMapping });
	if (json !== lastBroadcastJson) {
		lastBroadcastJson = json;
		broadcastMsg("status", {
			...telemetry,
			bond_mapping: bondMapping,
		});
	}
	return telemetry.linkTelemetry;
}
