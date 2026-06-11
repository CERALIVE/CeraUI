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
