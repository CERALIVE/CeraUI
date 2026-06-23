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

// Streaming module constants — centralized to prevent drift across spawn sites
// and telemetry consumers.

/** srtla_send listen port (env override: CERALIVE_SRTLA_PORT). */
export const SRTLA_LISTEN_PORT = parseInt(
	process.env.CERALIVE_SRTLA_PORT ?? "9000",
	10,
);

/** Timeout (ms) before SIGKILL is sent to processes that ignore SIGTERM. */
export const SHUTDOWN_SIGKILL_TIMEOUT_MS = 10_000;

/**
 * Grace (ms) for process-level graceful shutdown (systemd SIGTERM / Ctrl-C):
 * SIGTERM every subprocess, wait this long, then SIGKILL survivors. Distinct
 * from {@link SHUTDOWN_SIGKILL_TIMEOUT_MS} (the 10s in-app stream-stop budget) —
 * this is the shorter window systemd tolerates before it kills CeraUI itself.
 */
export const SHUTDOWN_SIGTERM_GRACE_MS = 5_000;

/** Timeout (ms) for audio device probe before failing stream start (QW-J). */
export const AUDIO_PROBE_TIMEOUT_MS = 15_000;

/** Debounce window (ms) collapsing bursts of audio device watcher events (QW-E). */
export const AUDIO_HOTPLUG_DEBOUNCE_MS = 500;

/** Fallback poll interval (ms) while streaming when fs.watch is unavailable (QW-E). */
export const AUDIO_HOTPLUG_POLL_INTERVAL_MS = 5_000;

/** Debounce window (ms) collapsing bursts of video device watcher events (T34). */
export const VIDEO_HOTPLUG_DEBOUNCE_MS = 200;

/** Unconditional rescan poll (ms): the reliable detector behind fs.watch so a
 *  hotplug is reflected in the picker within the 3s product budget (T34). */
export const VIDEO_HOTPLUG_POLL_INTERVAL_MS = 2_000;

// ─── timing / jitter (shared across periodic loops) ──────────────────────────
// Per-tick jitter de-correlates fleet-wide fixed-period timers so devices stop
// hitting a relay/hub on the same wall-clock boundary (thundering herd). Shared
// here by heartbeat, device-stats, and the modem poll.

/** Fractional jitter applied to periodic intervals: ±10% of the base period. */
export const PERIODIC_JITTER_FRACTION = 0.1;

/**
 * Apply ±`fraction` symmetric jitter to a base interval. Pure: the random
 * source is injectable so the bound is unit-testable. With the default
 * `fraction = 0.1` the result is uniformly distributed in [0.9·base, 1.1·base].
 *
 * @param baseMs   The nominal interval in milliseconds.
 * @param fraction Symmetric jitter fraction (0 → no jitter, 0.1 → ±10%).
 * @param rand     Uniform [0, 1) source (Math.random in production).
 */
export function applyJitter(
	baseMs: number,
	fraction: number = PERIODIC_JITTER_FRACTION,
	rand: () => number = Math.random,
): number {
	// rand() ∈ [0, 1) → offset ∈ [-fraction, +fraction)·baseMs.
	const offset = (rand() * 2 - 1) * fraction * baseMs;
	return baseMs + offset;
}

/**
 * Per-collector hard timeout (ms) for the device-stats sampling loop. A single
 * slow/hung hardware read (df, /proc, rauc) degrades that one signal to `null`
 * within this bound instead of stalling the whole 5s tick. Must stay well under
 * `DEVICE_STATS_INTERVAL_MS` so a timeout never overruns the next tick.
 */
export const DEVICE_STATS_COLLECTOR_TIMEOUT_MS = 2_000;

/** Max attempts for the link-telemetry iface resolver lazy load before giving up. */
export const IFACE_RESOLVER_MAX_RETRIES = 3;

/** Delay (ms) between iface resolver load attempts. */
export const IFACE_RESOLVER_RETRY_DELAY_MS = 1_000;

/** Connect/hello timeout (ms) for the srtla_send JSON-RPC control socket before
 *  the link-telemetry cutover gives up and stays on the --stats-file poll. */
export const SRTLA_CONTROL_CONNECT_TIMEOUT_MS = 5_000;
