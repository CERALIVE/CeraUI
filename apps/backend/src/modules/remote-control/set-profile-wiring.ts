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
 * Production wiring for the `device.setProfile` handler (Todo 28). Kept out of
 * `set-profile.ts` so the lazily-imported handler module never pulls the streaming
 * graph onto the command-router's load path. `main.ts` calls {@link wireSetProfile}
 * once at boot to bind the inert default deps to the real config / capabilities /
 * streaming session.
 *
 * `reconnect` is the apply-on-(re)connect side-effect: when a stream is active it
 * stops the stream, waits for the engine + processes to settle, then re-enters
 * connect with the persisted config (the only way to change latency — the engine
 * reload-config has no latency arm). It is bounded and never throws; if the stream
 * does not settle in time it leaves the running stream untouched and the persisted
 * config is applied on the next start instead.
 */

import { RUNTIME_CONFIG_DEFAULTS } from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import { getLastCapabilities } from "../streaming/capabilities.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import {
	start as startStream,
	stop as stopStream,
} from "../streaming/streamloop.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { configureSetProfile, type SetProfileCaps } from "./set-profile.ts";

const RECONNECT_SETTLE_TIMEOUT_MS = 5_000;
const RECONNECT_SETTLE_POLL_MS = 50;

function projectCaps(): SetProfileCaps {
	const caps = getLastCapabilities();
	return {
		supportedProfiles: caps?.supported_profiles,
		supportsFec: caps?.fec_capable ?? false,
		latencyRange: caps?.latency_range
			? { min: caps.latency_range.min, max: caps.latency_range.max }
			: undefined,
	};
}

function waitUntilIdle(): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const poll = () => {
			if (!getIsStreaming()) return resolve(true);
			if (Date.now() - start >= RECONNECT_SETTLE_TIMEOUT_MS) {
				return resolve(false);
			}
			setTimeout(poll, RECONNECT_SETTLE_POLL_MS);
		};
		poll();
	});
}

async function reconnect(): Promise<void> {
	if (!getIsStreaming()) return;
	stopStream();
	const settled = await waitUntilIdle();
	if (!settled) {
		logger.warn(
			"set-profile: stream did not settle within the reconnect window; persisted config applies on next start",
		);
		return;
	}
	// The control channel has no UI socket; a no-op stub satisfies the session's
	// status/error sends. Empty params → the start reads the just-persisted config.
	const stubConn = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as import("ws").default;
	await startStream(stubConn, {});
}

export function wireSetProfile(): void {
	configureSetProfile({
		getCaps: projectCaps,
		readActive: () => ({
			profile: getConfig().stream_profile ?? "custom",
			latencyMs:
				getConfig().srt_latency ?? RUNTIME_CONFIG_DEFAULTS.srt_latency ?? 0,
		}),
		persist: (resolved) => {
			const config = getConfig();
			config.stream_profile = resolved.presetId;
			config.srt_latency = resolved.latencyMs;
			config.fec_enabled = resolved.fecEnabled;
			config.recovery_mode = resolved.recoveryMode;
			saveConfig();
			broadcastMsg("config", config);
		},
		isStreaming: getIsStreaming,
		reconnect,
	});
}
