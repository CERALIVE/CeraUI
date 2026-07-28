/**
 * Load-time reconciliation of a persisted encode target against device truth
 * (device-quality-wave3 todo 11b).
 *
 * The save guard ({@link verifySaveDeviceMode}) stops a bad {resolution,
 * framerate} pairing being written. It does nothing for the fleet that already
 * has one on disk. Such a config is re-sent on every start and fails
 * `not-negotiated` every time, with no operator-visible reason — the exact
 * failure mode cerastream ADR-0008 §10 exists to end.
 *
 * TIMING. There is no "config load" moment at which this can run: `loadConfig()`
 * happens at boot, long before the engine's `list-devices` answers, and the
 * device's ladder is the only thing that can judge the pairing. The first moment
 * the ladder is known is the first `sources` build, which is why this hangs off
 * `broadcastSources` beside `reconcileConfiguredSourceIdentity` rather than off
 * the config loader.
 *
 * DIRECTION. The clamp is downward-biased (see `nearestDeliverableMode`): it
 * prefers the highest offered rung AT OR BELOW the persisted value. Clamping UP
 * would hand the operator a mode they never chose.
 *
 * ONE-TIME. The notification is keyed and fires at most once per process for a
 * given clamp — a repeated `sources` rebuild must not re-toast. After the clamp
 * the config is valid, so the guard below is silent on its own merits; the latch
 * covers the pathological case where a later ladder change re-invalidates it.
 */

import type { StreamSource } from "@ceraui/rpc";
import { getConfig, saveConfig } from "../config.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { clampPersistedDeviceMode } from "./device-mode-guard.ts";

/** Notification name (and persistent key) for the one-time clamp report. */
export const CLAMPED_MODE_NOTIFICATION = "encoder-mode-clamped";

const CLAMPED_MODE_KEY = "notifications.encoderModeClamped";

const CLAMPED_MODE_MSG =
	"Your saved encoder settings weren't supported by the connected camera and have been adjusted to the closest mode it can deliver.";

export interface PersistedModeClampDeps {
	notify: typeof notificationBroadcast;
	persist: typeof saveConfig;
}

function defaultDeps(): PersistedModeClampDeps {
	return { notify: notificationBroadcast, persist: saveConfig };
}

let notified = false;

/** Per-test isolation, and the boot reset for a fresh process. */
export function resetPersistedDeviceModeClamp(): void {
	notified = false;
}

/**
 * Clamp an out-of-ladder persisted encode target onto the nearest mode the
 * configured source can actually deliver. Returns whether the config changed.
 */
export function reconcilePersistedDeviceMode(
	sources: readonly StreamSource[],
	deps: PersistedModeClampDeps = defaultDeps(),
): boolean {
	const config = getConfig();
	if (config.resolution === undefined && config.framerate === undefined) {
		return false;
	}

	const nearest = clampPersistedDeviceMode(
		{
			sourceId: config.source,
			resolution: config.resolution,
			framerate: config.framerate,
		},
		{ sources, lastSeenDevices: config.last_seen_devices },
	);
	if (nearest === undefined) return false;

	const previousResolution = config.resolution;
	const previousFramerate = config.framerate;
	config.resolution = nearest.resolution;
	config.framerate = nearest.framerate;
	deps.persist();

	if (!notified) {
		notified = true;
		deps.notify(
			CLAMPED_MODE_NOTIFICATION,
			"warning",
			CLAMPED_MODE_MSG,
			0,
			true,
			true,
			true,
			CLAMPED_MODE_KEY,
			{
				resolution: nearest.resolution,
				framerate: nearest.framerate,
				...(previousResolution !== undefined ? { previousResolution } : {}),
				...(previousFramerate !== undefined ? { previousFramerate } : {}),
			},
		);
	}
	return true;
}
