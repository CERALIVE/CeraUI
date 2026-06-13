/**
 * HUD state derivation — pure, rune-free.
 *
 * Composes the domain sub-derivations (links, SoC telemetry, staleness) into a
 * single render-ready {@link HudState} snapshot. Never throws on
 * missing/partial/null inputs; last-known values are kept on disconnect and
 * callers rely on the `*Stale` flags rather than nulling data.
 */

import type { SensorsStatus, UpdatingStatus } from "@ceraui/rpc/schemas";
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

	return {
		isStreaming: sources.isStreaming,
		isStreamingStale: streamingStale,
		bitrateKbps: sources.config?.max_br ?? null,
		isBitrateStale: streamingStale,

		links: buildLinks(
			sources.modems,
			sources.wifi,
			sources.netif,
			modemsStale,
			wifiStale,
			isFullyStale,
			staleInterfaces,
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
