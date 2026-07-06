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
 * Production wiring for the active-profile reporter (cloud Todo 15). Kept out of
 * `active-profile-reporter.ts` so the reporter module stays disk-/config-free and
 * unit-testable — mirroring the `set-profile.ts` / `set-profile-wiring.ts` split.
 * `main.ts` calls {@link wireActiveProfileReporter} once at boot to bind the inert
 * default deps to the real persisted config + the `broadcastMsg` relay path.
 *
 * Source of truth is the ACTUALLY-applied StreamConfig the device streams under —
 * the persisted `stream_profile` / `srt_latency` / `fec_enabled` / `recovery_mode`
 * fields, NOT the last pushed `device.setProfile` command payload. Absent fields
 * fall back to the same defaults the engine + `set-profile.ts` apply (custom
 * preset, the SRTLA latency floor, FEC off, standard recovery).
 */

import {
	DEFAULT_RECOVERY_PREFERENCE,
	SRTLA_MIN_LATENCY_MS,
} from "@ceraui/rpc/schemas";

import { RUNTIME_CONFIG_DEFAULTS } from "../../helpers/config-schemas.ts";
import { getConfig } from "../config.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import {
	type ActiveProfileReport,
	configureActiveProfileReporter,
} from "./active-profile-reporter.ts";

/** Project the persisted runtime config onto the four reported StreamConfig fields. */
function projectActiveProfile(): ActiveProfileReport {
	const config = getConfig();
	return {
		presetId: config.stream_profile ?? "custom",
		latencyMs:
			config.srt_latency ??
			RUNTIME_CONFIG_DEFAULTS.srt_latency ??
			SRTLA_MIN_LATENCY_MS,
		fecEnabled: config.fec_enabled ?? false,
		recoveryMode: config.recovery_mode ?? DEFAULT_RECOVERY_PREFERENCE,
	};
}

export function wireActiveProfileReporter(): void {
	configureActiveProfileReporter({
		readActiveProfile: projectActiveProfile,
		broadcast: broadcastMsg,
	});
}
