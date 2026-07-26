/**
 * HUD state derivation — pure, rune-free.
 *
 * Composes the domain sub-derivations (links, SoC telemetry, staleness) into a
 * single render-ready {@link HudState} snapshot. Never throws on
 * missing/partial/null inputs; last-known values are kept on disconnect and
 * callers rely on the `*Stale` flags rather than nulling data.
 */

import type {
	EngineBitrate,
	SensorsStatus,
	UpdatingStatus,
} from "@ceraui/rpc/schemas";
import type { HudSources, HudState, HudTimestamps } from "$lib/types/hud";
import { STALE_THRESHOLD_MS } from "./constants";
import { buildLinks } from "./link-status";
import {
	parseCurrentAmps,
	parseSensorNumber,
	parseVolts,
} from "./soc-telemetry";
import { isTimestampStale } from "./staleness";

/** Whether an update is currently in progress (boolean flag or progress object). */
export function isUpdateInProgress(
	updating: UpdatingStatus | undefined,
): boolean {
	if (updating == null || updating === false) return false;
	if (updating === true) return true;
	// Progress object: a finished update reports result === 0.
	return typeof updating === "object" && updating.result !== 0;
}

/**
 * Split the operator's configured CEILING from the rate the engine has actually
 * APPLIED — the distinction the HUD previously collapsed.
 *
 * `config.max_br` is a request: CeraUI forwards it as the engine's
 * `bitrate.max_bitrate` and cerastream's adaptive controller is free to encode
 * anywhere below it when the link cannot carry the full rate. Rendering the
 * ceiling as "the bitrate" therefore reported the request as the result, which is
 * how a 5 Mbps configuration read "5 Mbps" on a link sustaining 3.
 *
 * An engine that reports no `engine_bitrate` (older build, or no live session)
 * falls back to the ceiling exactly as before, and `belowCeiling` stays false —
 * absence of evidence is never rendered as evidence of throttling.
 */
export function deriveBitrateReading(
	engineBitrate: EngineBitrate | null | undefined,
	ceilingKbps: number | null,
): { effectiveKbps: number | null; belowCeiling: boolean } {
	const applied = engineBitrate?.applied_kbps;
	if (applied === undefined) {
		return { effectiveKbps: ceilingKbps, belowCeiling: false };
	}
	// The engine's own ceiling is authoritative over the persisted config: a
	// reload the engine has not adopted yet would otherwise read as throttling.
	const ceiling = engineBitrate?.ceiling_kbps ?? ceilingKbps;
	return {
		effectiveKbps: applied,
		belowCeiling: ceiling != null && applied < ceiling,
	};
}

/**
 * Pure derivation: turn a point-in-time {@link HudSources} snapshot plus
 * {@link HudTimestamps} and a clock value into a complete {@link HudState}.
 *
 * Never throws on missing/partial/null inputs. Last-known values are kept on
 * disconnect; callers rely on the `*Stale` flags rather than nulling data.
 */
export function deriveHudState(
	sources: HudSources,
	timestamps: HudTimestamps,
	now: number,
	staleInterfaces: Set<string> = new Set(),
): HudState {
	const isConnected =
		sources.isConnected && sources.connectionState === "connected";

	const isFullyStale =
		!isConnected &&
		timestamps.connectionLostAt != null &&
		now - timestamps.connectionLostAt >= STALE_THRESHOLD_MS;

	// Cadence-aware: only sensors (~1s push) dim on age; modems (~30s), wifi and
	// config (on-change) are connection-backed and dim solely on disconnect, so
	// healthy data never flickers stale in the gaps between slow backend pushes.
	const sensorsStale =
		isTimestampStale(timestamps.sensors, now) || isFullyStale;
	const streamingStale = isFullyStale;
	const modemsStale = isFullyStale;
	const wifiStale = isFullyStale;

	const sensors: SensorsStatus | undefined = sources.sensors;

	const ceilingKbps = sources.config?.max_br ?? null;
	const bitrate = deriveBitrateReading(sources.engineBitrate, ceilingKbps);

	return {
		isStreaming: sources.isStreaming,
		isStreamingStale: streamingStale,
		// Live-Data Discipline (T6): bitrate is a live streaming value, so it must
		// not persist a stale number from the last session once the stream stops.
		bitrateKbps: sources.isStreaming ? bitrate.effectiveKbps : null,
		bitrateCeilingKbps: sources.isStreaming ? ceilingKbps : null,
		isBitrateBelowCeiling: sources.isStreaming && bitrate.belowCeiling,
		isBitrateStale: streamingStale,

		links: buildLinks(
			sources.modems,
			sources.wifi,
			sources.netif,
			modemsStale,
			wifiStale,
			isFullyStale,
			staleInterfaces,
			sources.isStreaming,
		),

		staleInterfaces,

		temperature: parseSensorNumber(sensors?.["SoC temperature"]),
		voltage: parseVolts(sensors?.["SoC voltage"]),
		current: parseCurrentAmps(sensors?.["SoC current"]),
		isSensorsStale: sensorsStale,

		isConnected,
		isFullyStale,

		isUpdating: isUpdateInProgress(sources.updating),

		lastUpdatedAt: {
			streaming: timestamps.streaming,
			sensors: timestamps.sensors,
			modems: timestamps.modems,
		},
	};
}
