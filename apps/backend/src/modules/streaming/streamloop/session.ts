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

// User-driven stream session control: the WebSocket-triggered `start` (validate
// config, refresh the srtla link list, launch) and the public `stop`
// orchestration that brings the engine down first, then the rest.

import type WebSocket from "ws";
import { logger } from "../../../helpers/logger.ts";
import { onNetworkInterfacesChange } from "../../network/network-interfaces.ts";
import { isUpdating } from "../../system/software-updates.ts";
import { notificationBroadcast } from "../../ui/notifications.ts";
import { sendStatus } from "../../ui/status.ts";
import { getSocketSenderId } from "../../ui/websocket-server.ts";
import { clearAsrcProbeReject, isAsrcProbeRejectResolved } from "../audio.ts";
import { setPendingAudioFollowAsrc } from "../auto-audio.ts";
import { clearBindMapReport } from "../bind-map-disposition.ts";
import { announceBindMapReport } from "../bind-map-notification.ts";
import { stopLinkTelemetry } from "../link-telemetry.ts";
import type { Pipeline } from "../pipelines.ts";
import { restartSrtla } from "../srtla.ts";
import {
	classifyStartFailure,
	StreamStartFailure,
} from "../start-failure-taxonomy.ts";
import {
	type ConfigParameters,
	getIsStreaming,
	startError,
	updateConfig,
	updateStatus,
} from "../streaming.ts";
import { getStreamingBackend } from "../streaming-engine.ts";
import { getStreamingProcesses, stopProcessAndWait } from "./process-runner.ts";
import { prepareSrtlaIpAddresses } from "./srtla-ip-preparation.ts";
import { type StartStreamResult, startStream } from "./start-stream.ts";

export {
	prepareSrtlaIpAddresses,
	type SrtlaIpPreparationDeps,
} from "./srtla-ip-preparation.ts";

type SessionResources = {
	readonly generation: number;
	readonly removeNetworkInterfacesChangeListener: () => void;
};

let sessionResources: SessionResources | undefined;

export async function start(
	conn: WebSocket,
	params: ConfigParameters,
	generation = 0,
	attemptId = "legacy-start",
): Promise<StartStreamResult> {
	if (getIsStreaming()) {
		sendStatus(conn);
		return {
			success: false,
			error: "stream_start_unavailable",
			reason: "stream_start_unavailable",
			phase: "params",
		};
	}
	if (isUpdating()) {
		sendStatus(conn);
		throw new StreamStartFailure({
			attemptId,
			phase: "connect",
			class: "engine_restarting",
			code: "stream_start_suppressed_update",
			retriable: true,
		});
	}

	const senderId = getSocketSenderId(conn);

	let c: {
		pipeline: Pipeline;
		srtlaAddr: string;
		srtlaPort: number;
		streamid: string;
	};
	try {
		c = await updateConfig(conn, params);
	} catch (err) {
		if (typeof err === "string") {
			startError(conn, err, senderId);
		} else {
			startError(conn, "Failed to save the config, unknown error", senderId);
			logger.error("Failed to save config", { err });
		}
		return {
			success: false,
			error: typeof err === "string" ? err : "start_invalid",
			reason: typeof err === "string" ? err : "start_invalid",
			phase: "params",
		};
	}

	if (sessionResources !== undefined) {
		reportSessionInvariant(
			generation,
			`start found resources owned by generation ${sessionResources.generation}`,
		);
		sessionResources.removeNetworkInterfacesChangeListener();
	}

	try {
		await prepareSrtlaIpAddresses(c.srtlaAddr);
	} catch (error) {
		throw new StreamStartFailure(
			classifyStartFailure("params", error, attemptId, {
				warn: (message, meta) => logger.warn(message, meta),
			}),
		);
	}
	const refreshSrtlaIpAddresses = async () => {
		try {
			// `changed` is true for a MAPPING-ONLY republication too — moving a link
			// from one interface to another leaves the IP bytes byte-identical, so a
			// SIGHUP keyed on the list alone would skip the very reload that carries
			// the new mapping.
			const publication = await prepareSrtlaIpAddresses(c.srtlaAddr);
			if (publication.changed && getIsStreaming()) restartSrtla();
		} catch (error) {
			logger.warn("Failed to refresh SRTLA IP addresses", { error });
		}
	};
	sessionResources = {
		generation,
		removeNetworkInterfacesChangeListener: onNetworkInterfacesChange(
			refreshSrtlaIpAddresses,
		),
	};

	let result: StartStreamResult;
	try {
		result = await startStream(
			c.pipeline,
			c.srtlaAddr,
			c.srtlaPort,
			c.streamid,
			{},
			attemptId,
		);
	} catch (err) {
		if (sessionResources?.generation === generation) {
			sessionResources.removeNetworkInterfacesChangeListener();
			sessionResources = undefined;
		}
		if (err instanceof StreamStartFailure) throw err;
		if (typeof err === "string") {
			startError(conn, err, senderId);
		} else {
			startError(conn, "Failed to start, unknown error", senderId);
			logger.error("Failed to start stream", { err });
		}
		return {
			success: false,
			error: typeof err === "string" ? err : "engine_internal",
			reason: typeof err === "string" ? err : "engine_internal",
			phase: "spawn-sender",
		};
	}

	if (!result.success && sessionResources?.generation === generation) {
		sessionResources.removeNetworkInterfacesChangeListener();
		sessionResources = undefined;
	}
	return result;
}

function reportSessionInvariant(generation: number, reason: string): void {
	logger.error("stream-session invariant violation", { generation, reason });
	notificationBroadcast(
		"stream_session_recovered",
		"warning",
		"The stream session had inconsistent resource ownership and was recovered.",
		10,
		false,
		true,
	);
}

export function stopGeneration(generation: number): Promise<void> {
	// A deferred auto-audio follow (T7) only applies at the NEXT start; a stop
	// cancels it so the picker never keeps a stale "follows on restart" hint.
	setPendingAudioFollowAsrc(null);

	return new Promise((resolve) => {
		let finishPromise: Promise<void> | undefined;
		const finish = () => {
			if (finishPromise !== undefined) return finishPromise;
			finishPromise = (async () => {
				if (sessionResources?.generation === generation) {
					sessionResources.removeNetworkInterfacesChangeListener();
					sessionResources = undefined;
				}
				await Promise.all(
					[...getStreamingProcesses()].map((process) =>
						stopProcessAndWait(process),
					),
				);
				stopLinkTelemetry();
				// A stopped session makes no claim about a bond, so the degradation
				// band is retracted rather than left standing over nothing.
				clearBindMapReport();
				announceBindMapReport();
				updateStatus(false);
				resolve();
			})();
			return finishPromise;
		};

		if (isAsrcProbeRejectResolved()) {
			clearAsrcProbeReject();

			if (getStreamingProcesses().length === 0) {
				void finish();
				return;
			}

			reportSessionInvariant(
				generation,
				"audio probe cancellation overlapped running processes",
			);
		}

		// Bring the engine down first (it owns the engine-first shutdown ordering),
		// then sweep the rest once it has exited.
		const foundEngine = getStreamingBackend().stop(() => {
			void finish();
		});

		if (!foundEngine) {
			if (
				sessionResources?.generation === generation ||
				getStreamingProcesses().length > 0
			) {
				reportSessionInvariant(
					generation,
					"engine session missing while generation-owned resources remained",
				);
			}
			void finish();
		}
	});
}

export function stop(): void {
	setPendingAudioFollowAsrc(null);
	if (isAsrcProbeRejectResolved()) clearAsrcProbeReject();
	void import("../stream-session-orchestrator.ts").then(
		({ stopStreamSession }) => stopStreamSession("operator"),
	);
}
