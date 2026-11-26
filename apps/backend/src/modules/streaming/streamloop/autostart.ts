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
import { broadcastConfig } from "../../../rpc/config-broadcast.ts";
import { getConfig, saveConfig } from "../../config.ts";
import { emitEvent } from "../../events/emit.ts";
import { isUpdating } from "../../system/software-updates.ts";
import { notificationBroadcast } from "../../ui/notifications.ts";
import { deviceRegistry } from "../devices.ts";
import { awaitRecoveryBarrier } from "../recovery-barrier.ts";
import { genSrtlaIpList, resolveSrtla } from "../srtla.ts";
import { acceptStartAudio } from "../start-audio.ts";
import { mergePersistedStartConfig } from "../start-config-merge.ts";
import {
	classifyStartFailure,
	StreamStartFailure,
	typedStartFailure,
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

	broadcastConfig(config);
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
	// Autostart records a failed result and never retries, so it is invoked only
	// once modem-mutation replay has finished — a refusal here is not a deferral,
	// it is the whole boot intent being discarded.
	await awaitRecoveryBarrier();

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
		try {
			emitEvent("stream_autostart_failed", {
				reason: "network_links_unavailable",
			});
		} catch {
			// Event history must not alter stream control.
		}
		notificationBroadcast(
			"stream_autostart_failed",
			"error",
			`Automatic stream start failed: no network links became available after ${linkAttempt}/${AUTOSTART_MAX_LINK_ATTEMPTS} checks. Open Settings → System Logs for details.`,
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
	const sourceStableId = config.source_stable_id;
	const selectedVideoInput =
		config.selected_video_input ?? deviceRegistry.getActiveInput();
	const startAudio = acceptStartAudio({}, config);
	let c: Awaited<ReturnType<typeof validateConfig>>;
	try {
		c = await validateConfig(
			{ ...mergePersistedStartConfig(config, {}), ...startAudio.config },
			startAudio,
		);
		c.config.source_stable_id = sourceStableId;
		c.config.selected_video_input = selectedVideoInput;
	} catch (err) {
		logger.error("autostart failed", { err });
		try {
			emitEvent("stream_autostart_failed", { reason: "start_invalid" });
		} catch {
			// Event history must not alter stream control.
		}
		notificationBroadcast(
			"stream_autostart_failed",
			"error",
			"Automatic stream start failed: configuration or device is invalid. Open Settings → System Logs for details.",
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

	let relayAddress: string | undefined;
	const starting = startStreamSession({
		origin: "autostart",
		launch: async ({ attemptId }) => {
			relayAddress ??= await resolveSrtla(c.srtlaAddr);
			const launched = await startStream(
				c.pipeline,
				relayAddress,
				c.srtlaPort,
				c.streamid,
				{},
				attemptId,
				c.config,
				startAudio,
			);
			if (!launched.success) {
				throw new StreamStartFailure(
					launched.failureClass !== undefined
						? typedStartFailure(
								attemptId,
								launched.phase,
								launched.failureClass,
								launched.error,
							)
						: classifyStartFailure(launched.phase, launched.error, attemptId),
				);
			}
		},
	});
	const result = await startAudio.whileInFlight(starting);
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
