/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

/* Stream starting, stopping, management and monitoring */
import type WebSocket from "ws";

import { validateInteger, validatePortNo } from "../../helpers/number.ts";

import { getConfig, saveConfig } from "../config.ts";
import { notificationSend } from "../ui/notifications.ts";
import type { StatusResponseMessage } from "../ui/status.ts";
import {
	broadcastMsg,
	buildMsg,
	deleteSocketSenderId,
	getSocketSenderId,
	setSocketSenderId,
} from "../ui/websocket-server.ts";

import {
	convertManualToRemoteRelay,
	getRelays,
} from "../remote/remote-relays.ts";
import {
	DEFAULT_AUDIO_ID,
	abortAsrcRetry,
	asrcProbe,
	asrcScheduleRetry,
	audioCodecs,
	getAudioDevices,
	isAsrcRetryScheduled,
	pipelineSetAsrc,
} from "./audio.ts";
import { setBitrate } from "./encoder.ts";
import { removeBitrateOverlay, searchPipelines } from "./pipelines.ts";
import { resolveSrtla } from "./srtla.ts";

export type StartMessage = { start: ConfigParameters };

export type ConfigParameters = {
	delay?: string;
	srt_latency?: string;
	pipeline?: string;
	acodec?: string;
	relay_server?: string;
	relay_account?: string;
	srtla_addr?: string;
	srtla_port?: string;
	srt_streamid?: string;
	asrc?: string;
	bitrate_overlay?: unknown;
	max_br?: string;
};

let isStreaming = false;

export function getIsStreaming() {
	return isStreaming;
}

export function updateStatus(status: boolean) {
	if (status !== isStreaming) {
		isStreaming = status;
		broadcastMsg("status", { is_streaming: isStreaming });
		return true;
	}

	return false;
}

export function startError(conn: WebSocket, msg: string, id?: string) {
	const originalId = getSocketSenderId(conn);
	if (id !== undefined) {
		setSocketSenderId(conn, id);
	}

	notificationSend(conn, "start_error", "error", msg, 10);

	if (id !== undefined) {
		if (originalId) {
			setSocketSenderId(conn, originalId);
		} else {
			deleteSocketSenderId(conn);
		}
	}

	if (!updateStatus(false)) {
		conn.send(
			buildMsg("status", {
				is_streaming: false,
			} satisfies StatusResponseMessage),
		);
	}

	return false;
}

export async function updateConfig(
	conn: WebSocket,
	params: ConfigParameters,
	callback: (
		pipelineFilePath: string,
		srtlaAddr: string,
		srtlaPort?: number,
		streamid?: string,
	) => void,
) {
	if (isAsrcRetryScheduled()) {
		abortAsrcRetry();
	}

	// delay
	if (params.delay === undefined)
		return startError(conn, "audio delay not specified");
	const delay = validateInteger(params.delay, -2_000, 2_000);
	if (validateInteger === undefined)
		return startError(conn, `invalid delay '${params.delay}'`);

	// pipeline
	if (params.pipeline === undefined)
		return startError(conn, "pipeline not specified");
	const pipeline = searchPipelines(params.pipeline);
	if (pipeline == null) return startError(conn, "pipeline not found");
	let pipelineFilePath: string | undefined = pipeline.path;

	// audio codec, if needed for the pipeline
	let audioCodec: string | undefined;
	if (pipeline.acodec) {
		if (params.acodec === undefined) {
			return startError(conn, "audio codec not specified");
		}
		if (!audioCodecs[params.acodec]) {
			return startError(conn, "audio codec not found");
		}
		audioCodec = params.acodec;
	}

	// remove the bitrate overlay unless enabled in the config
	if (!params.bitrate_overlay) {
		pipelineFilePath = await removeBitrateOverlay(pipelineFilePath);
		if (!pipelineFilePath)
			return startError(
				conn,
				"failed to generate the pipeline file - bitrate overlay",
			);
	}

	// bitrate
	const maxBitrate = params.max_br
		? Number.parseInt(params.max_br, 10)
		: undefined;
	const bitrate = setBitrate({ max_br: maxBitrate });
	if (bitrate == null) return startError(conn, "invalid bitrate range: ");

	// srt latency
	if (params.srt_latency === undefined)
		return startError(conn, "SRT latency not specified");
	const srtLatency = validateInteger(params.srt_latency, 100, 10_000);
	if (srtLatency === undefined)
		return startError(conn, `invalid SRT latency '${params.srt_latency}' ms`);

	// srtla addr & port
	let srtlaAddr: string | undefined;
	let srtlaPort: number | undefined;
	const relays = getRelays();
	if (relays && params.relay_server) {
		const relayServer = relays.servers[params.relay_server];
		if (!relayServer) {
			return startError(conn, "Invalid relay server specified");
		}
		srtlaAddr = relayServer.addr;
		srtlaPort = relayServer.port;
	} else {
		if (params.srtla_addr === undefined)
			return startError(conn, "SRTLA address not specified");
		srtlaAddr = params.srtla_addr.trim();

		if (params.srtla_port === undefined)
			return startError(conn, "SRTLA port not specified");
		srtlaPort = validatePortNo(params.srtla_port);
		if (!srtlaPort)
			return startError(conn, `invalid SRTLA port '${params.srtla_port}'`);
	}

	// srt streamid
	let streamid: string | undefined;
	if (relays && params.relay_server && params.relay_account) {
		const relayAccount = relays.accounts[params.relay_account];
		if (!relayAccount) {
			return startError(conn, "Invalid relay account specified!");
		}
		streamid = relayAccount.ingest_key;
	} else {
		if (params.srt_streamid === undefined)
			return startError(conn, "SRT streamid not specified");
		streamid = params.srt_streamid;
	}

	// resolve the srtla hostname
	srtlaAddr = await resolveSrtla(srtlaAddr, conn);
	if (!srtlaAddr) return;

	const config = getConfig();

	// audio capture device, if needed for the pipeline
	let audioSrcId: string | undefined = DEFAULT_AUDIO_ID;
	if (pipeline.asrc) {
		if (params.asrc === undefined) {
			return startError(conn, "audio source not specified");
		}

		audioSrcId = getAudioDevices()[params.asrc];
		if (!audioSrcId && params.asrc !== config.asrc) {
			return startError(conn, "selected audio source not found");
		}

		audioSrcId = asrcProbe(params.asrc);
	}

	if (pipeline.asrc) {
		config.asrc = params.asrc;
	}

	if (pipeline.acodec) {
		config.acodec = params.acodec;
	}

	config.delay = delay;
	config.pipeline = params.pipeline;
	config.max_br = maxBitrate;
	config.srt_latency = srtLatency;
	config.bitrate_overlay = Boolean(params.bitrate_overlay);
	if (params.relay_server) {
		config.relay_server = params.relay_server;
		config.srtla_addr = undefined;
		config.srtla_port = undefined;
	} else {
		config.srtla_addr = srtlaAddr;
		config.srtla_port = srtlaPort;
		config.relay_server = undefined;
	}
	if (params.relay_account) {
		config.relay_account = params.relay_account;
		config.srt_streamid = undefined;
	} else {
		config.srt_streamid = params.srt_streamid;
		config.relay_account = undefined;
	}

	if (!params.relay_server || !params.relay_account) {
		convertManualToRemoteRelay();
	}

	saveConfig();

	broadcastMsg("config", config);

	if (audioSrcId) {
		pipelineFilePath = await pipelineSetAsrc(
			pipelineFilePath,
			audioSrcId,
			audioCodec,
		);
		if (!pipelineFilePath) return;

		callback(pipelineFilePath, srtlaAddr, srtlaPort, streamid);
	} else {
		asrcScheduleRetry(
			callback,
			pipelineFilePath,
			srtlaAddr,
			srtlaPort,
			streamid,
		);
		updateStatus(true);
	}
}
