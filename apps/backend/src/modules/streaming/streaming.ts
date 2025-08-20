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

import { validatePortNo } from "../../helpers/number.ts";

import { getConfig, saveConfig } from "../config.ts";
import { convertManualToRemoteRelay, getRelays } from "../remote/remote-relays.ts";
import { notificationSend } from "../ui/notifications.ts";
import type { StatusResponseMessage } from "../ui/status.ts";
import {
	broadcastMsg,
	buildMsg,
	deleteSocketSenderId,
	getSocketSenderId,
	setSocketSenderId,
} from "../ui/websocket-server.ts";
import { audioCodecs, getAudioDevices } from "./audio.ts";
import { updateBcrptServerIps } from "./bcrpt.ts";
import { validateBitrate } from "./encoder.ts";
import { searchPipelines } from "./pipelines.ts";
import { resolveSrtla } from "./srtla.ts";

export type StartMessage = { start: ConfigParameters };

export type ConfigParameters = {
	delay?: number;
	srt_latency?: number;
	pipeline?: string;
	acodec?: string;
	relay_server?: string;
	relay_account?: string;
	srtla_addr?: string;
	srtla_port?: number;
	srt_streamid?: string;
	asrc?: string;
	bitrate_overlay?: boolean;
	max_br?: number;
	autostart?: boolean;
};

let isStreaming = false;

export function getIsStreaming() {
	return isStreaming;
}

export function updateStatus(status: boolean) {
	if (status !== isStreaming) {
		isStreaming = status;
		broadcastMsg("status", { is_streaming: isStreaming });

		// Clear out the BCRP server list on start, and re-populate it on stop
		updateBcrptServerIps();

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

export async function validateConfig(params: Partial<ConfigParameters>) {
	if (typeof params !== "object") throw new Error("Invalid config");

	// A-V delay
	if (typeof params.delay !== "number") throw new Error("Invalid audio delay");
	const delay = Number.parseInt(params.delay.toString(), 10);
	if (delay !== params.delay || delay < -2000 || delay > 2000)
		throw new Error(`Invalid audio delay '${params.delay}'`);
	params.delay = delay;

	// pipeline
	if (typeof params.pipeline !== "string") throw new Error("Invalid pipeline");
	const pipeline = searchPipelines(params.pipeline);
	if (!pipeline) throw new Error("Pipeline not found");

	// audio codec
	if (pipeline.acodec) {
		if (typeof params.acodec !== "string") throw new Error("Invalid audio codec");
		if (!audioCodecs[params.acodec]) throw new Error("Audio codec not found");
	}

	// audio source
	const config = getConfig();
	const audioDevicesMap = getAudioDevices();
	if (pipeline.asrc) {
		if (typeof params.asrc !== "string") throw new Error("Invalid audio source");
		if (params.asrc !== config.asrc && !audioDevicesMap[params.asrc])
			throw new Error("Selected audio source not found");
	}

	// bitrate
	if (!validateBitrate(params)) throw new Error(`Invalid max bitrate: '${params.max_br}'`);

	// SRT latency
	if (typeof params.srt_latency !== "number") throw new Error("Invalid SRT latency");
	const srtLatency = Number.parseInt(params.srt_latency.toString(), 10);
	if (srtLatency !== params.srt_latency || srtLatency < 100 || srtLatency > 10_000)
		throw new Error(`Invalid SRT latency '${params.srt_latency}' ms`);
	params.srt_latency = srtLatency;

	// SRTLA addr and port
	let srtlaAddr: string;
	let srtlaPort: number;
	const relays = getRelays();
	if (relays && params.relay_server) {
		const relayServer = relays.servers[params.relay_server];
		if (!relayServer) throw new Error("Invalid relay server");
		srtlaAddr = relayServer.addr;
		srtlaPort = relayServer.port;
	} else {
		if (typeof params.srtla_addr !== "string") throw new Error("Invalid SRTLA address");
		srtlaAddr = params.srtla_addr.trim();

		const port = validatePortNo(params.srtla_port);
		if (!port) throw new Error(`Invalid SRTLA port '${params.srtla_port}'`);
		srtlaPort = params.srtla_port = port;
	}

	// stream ID
	let streamid: string;
	if (relays && params.relay_server && params.relay_account) {
		const relayAccount = relays.accounts[params.relay_account];
		if (!relayAccount) throw new Error("Invalid relay account specified!");
		streamid = relayAccount.ingest_key;
	} else {
		if (typeof params.srt_streamid !== "string") throw new Error("SRT streamid not specified");
		streamid = params.srt_streamid;
	}

	return { pipeline, srtlaAddr, srtlaPort, streamid };
}

export async function updateConfig(_conn: WebSocket, params: ConfigParameters) {
	const { pipeline, srtlaAddr: initialAddr, srtlaPort, streamid } = await validateConfig(params);

	const srtlaAddr = await resolveSrtla(initialAddr);
	const config = getConfig();
	// Save the updated config
	config.delay = params.delay;
	config.pipeline = params.pipeline;
	config.max_br = params.max_br;
	config.srt_latency = params.srt_latency;
	config.bitrate_overlay = params.bitrate_overlay;

	if (pipeline.acodec) {
		config.acodec = params.acodec!;
	}
	if (pipeline.asrc) {
		config.asrc = params.asrc!;
	}

	if (params.relay_server) {
		config.relay_server = params.relay_server;
		config.srtla_addr = undefined;
		config.srtla_port = undefined;
	} else {
		config.srtla_addr = params.srtla_addr!;
		config.srtla_port = params.srtla_port!;
		config.relay_server = undefined;
	}

	if (params.relay_account) {
		config.relay_account = params.relay_account;
		config.srt_streamid = undefined;
	} else {
		config.srt_streamid = params.srt_streamid!;
		config.relay_account = undefined;
	}

	if (!params.relay_server || !params.relay_account) {
		convertManualToRemoteRelay();
	}

	saveConfig();
	broadcastMsg("config", config);

	return { pipeline, srtlaAddr, srtlaPort, streamid };
}
