/*
    CeraUI - web UI for the CERALIVE project
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

// Autostart lifecycle: the boot-time "resume stream if configured" path with its
// retry/backoff (no network links yet, transient resolver failures) plus the
// `setAutostart` config toggle.

import fs from "node:fs";
import { logger } from "../../../helpers/logger.ts";
import { AUTOSTART_RETRY_DELAY } from "../../../helpers/timing-constants.ts";
import { getConfig, saveConfig } from "../../config.ts";
import { isUpdating } from "../../system/software-updates.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import type { Pipeline } from "../pipelines.ts";
import { genSrtlaIpList, resolveSrtla } from "../srtla.ts";
import { classifyStartFailure } from "../start-failure-taxonomy.ts";
import {
	StreamStartFailure,
	startStreamSession,
} from "../stream-session-orchestrator.ts";
import { getIsStreaming, validateConfig } from "../streaming.ts";
import { startStream } from "./start-stream.ts";

export const AUTOSTART_CHECK_FILE = "/tmp/ceralive_restarted";

export function setAutostart(value: boolean): boolean {
	const config = getConfig();
	config.autostart = value;
	saveConfig();

	broadcastMsg("config", config);
	return config.autostart;
}

export async function checkAutoStartStream() {
	// Don't autostart when restarting CeraLive after a software update or after a crash
	if (getConfig().autostart && !fs.existsSync(AUTOSTART_CHECK_FILE)) {
		void autoStartStream();
	}
	fs.writeFileSync(AUTOSTART_CHECK_FILE, "");
}

export async function autoStartStream(): Promise<void> {
	if (getIsStreaming() || isUpdating()) {
		logger.info("autostart aborted");
		return;
	}

	/* Populate the connections list file for srtla_send
       If no interfaces are available, retry later as we won't be able to stream yet */
	if (genSrtlaIpList().length < 1) {
		setTimeout(autoStartStream, AUTOSTART_RETRY_DELAY);
		return;
	}

	// If the config is invalid, then we won't ever be able to start, so don't retry
	const config = getConfig();
	let c: {
		pipeline: Pipeline;
		srtlaAddr: string;
		srtlaPort: number;
		streamid: string;
	};
	try {
		c = await validateConfig(config);
	} catch (err) {
		logger.error("autostart failed", { err });
		return;
	}

	const result = await startStreamSession({
		origin: "autostart",
		launch: async ({ attemptId }) => {
			const srtlaAddr: string = await resolveSrtla(c.srtlaAddr);
			const launched = await startStream(
				c.pipeline,
				srtlaAddr,
				c.srtlaPort,
				c.streamid,
			);
			if (!launched.success) {
				throw new StreamStartFailure(
					classifyStartFailure("spawn-sender", launched.error, attemptId),
				);
			}
		},
	});
	if (result.result === "failed") {
		logger.warn("autostart failed, but will retry", { result });
		setTimeout(autoStartStream, AUTOSTART_RETRY_DELAY);
		return;
	}
	if (result.result === "busy") {
		logger.info("autostart aborted", { result });
		return;
	}
	if (result.result === "cancelled") {
		logger.info("autostart cancelled", { result });
		return;
	}

	logger.info("autostart complete");
}
