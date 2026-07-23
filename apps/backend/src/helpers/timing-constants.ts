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

/**
 * Centralized timing constants for streaming modules
 * Extracted from hardcoded values to enable consistent tuning and testing
 */

// BCRPT retry logic (bcrpt.ts)
export const MAX_BCRPT_RETRIES = 5;
export const INITIAL_RETRY_DELAY = 1000; // ms

// Autostart retry delay (streamloop.ts)
// Retry interval when no interfaces are available or autostart fails
export const AUTOSTART_RETRY_DELAY = 1000; // ms

export const ENGINE_STATE_RECONCILE_TIMEOUT = 2500;

// Audio source polling delay (audio.ts)
// Retry interval when selected audio input is unavailable
export const AUDIO_SOURCE_POLL_DELAY = 1000; // ms
