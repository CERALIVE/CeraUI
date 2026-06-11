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
// orchestration that brings ceracoder down first, then the rest.

import type WebSocket from "ws";
import { isLocalIp } from "../../../helpers/ip-addresses.ts";
import { logger } from "../../../helpers/logger.ts";
import { onNetworkInterfacesChange } from "../../network/network-interfaces.ts";
import { isUpdating } from "../../system/software-updates.ts";
import { sendStatus } from "../../ui/status.ts";
import { getSocketSenderId } from "../../ui/websocket-server.ts";
import { clearAsrcProbeReject, isAsrcProbeRejectResolved } from "../audio.ts";
import { stopLinkTelemetry } from "../link-telemetry.ts";
import type { Pipeline } from "../pipelines.ts";
import {
	genSrtlaIpList,
	genSrtlaIpListForLocalIpAddress,
	restartSrtla,
	setSrtlaIpList,
} from "../srtla.ts";
import {
	type ConfigParameters,
	getIsStreaming,
	startError,
	updateConfig,
	updateStatus,
} from "../streaming.ts";
import {
	getStreamingProcesses,
	stopAll,
	stopProcess,
} from "./process-runner.ts";
import { startStream } from "./start-stream.ts";

let removeNetworkInterfacesChangeListener: (() => void) | undefined;

export async function start(
	conn: WebSocket,
	params: ConfigParameters,
): Promise<void> {
	if (getIsStreaming() || isUpdating()) {
		sendStatus(conn);
		return;
	}

	updateStatus(true);
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
		return;
	}

	if (removeNetworkInterfacesChangeListener) {
		removeNetworkInterfacesChangeListener();
	}

	const handleSrtlaIpAddresses = async () => {
		const srtlaIpList = isLocalIp(c.srtlaAddr)
			? genSrtlaIpListForLocalIpAddress(c.srtlaAddr)
			: genSrtlaIpList();
		if (!srtlaIpList.length) {
			startError(
				conn,
				"Failed to start, no available network connections",
				senderId,
			);
			return;
		}

		await setSrtlaIpList(srtlaIpList);

		if (getIsStreaming()) {
			restartSrtla();
		}
	};

	handleSrtlaIpAddresses();
	removeNetworkInterfacesChangeListener = onNetworkInterfacesChange(
		handleSrtlaIpAddresses,
	);

	try {
		await startStream(c.pipeline, c.srtlaAddr, c.srtlaPort, c.streamid);
	} catch (err) {
		if (typeof err === "string") {
			startError(conn, err, senderId);
		} else {
			startError(conn, "Failed to start, unknown error", senderId);
			logger.error("Failed to start stream", { err });
		}
		return;
	}
}

export function stop() {
	if (isAsrcProbeRejectResolved()) {
		clearAsrcProbeReject();

		if (getStreamingProcesses().length === 0) {
			updateStatus(false);
			stopLinkTelemetry();
			return;
		}

		logger.error("stop: BUG?: found both an asrcProbe and running processes");
	}

	let foundCeracoder = false;

	for (const p of getStreamingProcesses()) {
		p.exitListeners = [];
		if (p.spawnfile.endsWith("ceracoder")) {
			foundCeracoder = true;
			logger.debug("stop: found the ceracoder process");

			if (!stopProcess(p)) {
				// if the process is active, wait for it to exit
				p.exitListeners.push(() => {
					logger.info("stop: ceracoder terminated");
					stopAll();
				});
			} else {
				// if ceracoder has terminated already, skip to the next step
				logger.info("stop: ceracoder already terminated");
				stopAll();
			}
		}
	}

	if (!foundCeracoder) {
		logger.error("stop: BUG?: ceracoder not found, terminating all processes");
		stopAll();
	}
}
