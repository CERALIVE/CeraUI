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
	createControlClient,
	supportsStatsSubscription,
} from "@ceralive/srtla-send/control";
import {
	senderTelemetryPath,
	type Telemetry,
	type WatchTelemetryHandle,
	watchTelemetry,
} from "@ceralive/srtla-send/telemetry";
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
	asCumulativeBytes,
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

type ControlClientFactory = typeof createControlClient;
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
function ingestTelemetry(telemetry: Telemetry | null): void {
	if (telemetry) {
		lastSnapshot = telemetry;
		lastTickFresh = true;
		lastReadMs = nowFn();
		// The sender's own verdict REPLACES the writer's synthesized one, and it
		// is the only half that can observe a degraded reload.
		ingestSenderBindMapReport(telemetry);
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
 * watcher running (connect failure, hello timeout, capability absent, subscribe
 * error). Only once the sender advertises `stats-subscription` AND the stream is
 * open do we stop the poll and source telemetry from pushed `event` frames. A
 * mid-stream null (parse failure / disconnect) re-arms the file-poll.
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

		const hello = await client.hello().catch(() => null);
		if (!hello || !supportsStatsSubscription(hello)) {
			client.close();
			return;
		}

		subscriptionCleanup = client.subscribeStats((snapshot) => {
			if (snapshot === null && !handle) {
				logger.warn(
					"link-telemetry: subscription disconnected, falling back to file-poll",
				);
				startFilePollWatcher(watch, statsFile, watchOpts);
			}
			ingestTelemetry(snapshot);
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

	const links = buildLinkRows(
		lastSnapshot,
		!lastTickFresh,
		isBondMappingActive(),
	);
	// Forwarded verbatim, never summed from `links`: the sender's accumulator is
	// what stays monotonic across a reconnect or an IP-list reload.
	const bondBytesSentTotal = asCumulativeBytes(lastSnapshot);
	return {
		links,
		measured_bps: links.reduce((total, link) => total + link.bitrate_bps, 0),
		...(bondBytesSentTotal === undefined
			? {}
			: { bytes_sent_total: bondBytesSentTotal }),
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
	const bondMapping = buildBondMapping();
	const json = JSON.stringify({ payload, bondMapping });
	if (json !== lastBroadcastJson) {
		lastBroadcastJson = json;
		broadcastMsg("status", {
			linkTelemetry: payload,
			bond_mapping: bondMapping,
		});
	}
	return payload;
}
