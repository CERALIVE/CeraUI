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
import { notificationBroadcast } from "../../ui/notifications.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import type { Pipeline } from "../pipelines.ts";
import { genSrtlaIpList, resolveSrtla } from "../srtla.ts";
import {
	classifyStartFailure,
	StreamStartFailure,
} from "../start-failure-taxonomy.ts";
import { startStreamSession } from "../stream-session-orchestrator.ts";
import { getIsStreaming, validateConfig } from "../streaming.ts";
import { startStream } from "./start-stream.ts";

export const AUTOSTART_CHECK_FILE = "/tmp/ceralive_restarted";
export const AUTOSTART_MAX_LINK_ATTEMPTS = 5;

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

export async function autoStartStream(linkAttempt = 1): Promise<void> {
	if (getIsStreaming() || isUpdating()) {
		logger.info("autostart aborted");
		return;
	}

	/* Populate the connections list file for srtla_send
       If no interfaces are available, retry later as we won't be able to stream yet */
	if (genSrtlaIpList().length < 1) {
		if (linkAttempt < AUTOSTART_MAX_LINK_ATTEMPTS) {
			setTimeout(
				() => void autoStartStream(linkAttempt + 1),
				AUTOSTART_RETRY_DELAY,
			);
			return;
		}
		logger.error("autostart failed", {
			class: "network_links_unavailable",
			attempt: linkAttempt,
			maxAttempts: AUTOSTART_MAX_LINK_ATTEMPTS,
			retryState: "exhausted",
		});
		notificationBroadcast(
			"stream_autostart_failed",
			"error",
			`Automatic stream start failed: no network links became available after ${linkAttempt}/${AUTOSTART_MAX_LINK_ATTEMPTS} checks. Check journalctl -u ceralive.service.`,
			0,
			false,
			true,
			true,
			"notifications.streamAutostartNoLinksFailed",
			{
				attempt: linkAttempt,
				maxAttempts: AUTOSTART_MAX_LINK_ATTEMPTS,
				class: "network_links_unavailable",
				retryState: "exhausted",
			},
		);
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
		notificationBroadcast(
			"stream_autostart_failed",
			"error",
			"Automatic stream start failed: configuration or device is invalid. Check journalctl -u ceralive.service.",
			0,
			false,
			true,
			true,
			"notifications.streamStartInvalidFailed",
			{
				phase: "params",
				class: "start_invalid",
				retryState: "not_retriable",
			},
		);
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
				{},
				attemptId,
			);
			if (!launched.success) {
				throw new StreamStartFailure(
					classifyStartFailure(launched.phase, launched.error, attemptId),
				);
			}
		},
	});
	if (result.result === "failed") {
		logger.error("autostart failed", {
			attemptId: result.attemptId,
			phase: result.failure.phase,
			class: result.failure.class,
			...(result.failure.code !== undefined
				? { code: result.failure.code }
				: {}),
			retryState: result.failure.retriable ? "exhausted" : "not_retriable",
		});
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
