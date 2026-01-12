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

import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs";
import type { Readable } from "node:stream";
import type WebSocket from "ws";
import { isLocalIp } from "../../helpers/ip-addresses.ts";
import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import { onNetworkInterfacesChange } from "../network/network-interfaces.ts";
import { setup } from "../setup.ts";
import {
	isUpdating,
	periodicCheckForSoftwareUpdates,
} from "../system/software-updates.ts";
import {
	notificationBroadcast,
	notificationExists,
} from "../ui/notifications.ts";
import { sendStatus } from "../ui/status.ts";
import { broadcastMsg, getSocketSenderId } from "../ui/websocket-server.ts";
import {
	asrcProbe,
	clearAsrcProbeReject,
	getAudioSrcId,
	isAsrcProbeRejectResolved,
} from "./audio.ts";
import { hasLowMtu } from "./bcrpt.ts";
import { setBitrate } from "./encoder.ts";
import { type Pipeline, generatePipelineFile } from "./pipelines.ts";
import {
	genSrtlaIpList,
	genSrtlaIpListForLocalIpAddress,
	resolveSrtla,
	restartSrtla,
	setSrtlaIpList,
} from "./srtla.ts";
import {
	getCeracoderExec,
	buildCeracoderArgsAndWriteConfig,
} from "./ceracoder.ts";
import {
	type ConfigParameters,
	getIsStreaming,
	startError,
	updateConfig,
	updateStatus,
	validateConfig,
} from "./streaming.ts";

type ChildProcess = ChildProcessByStdio<null, null, Readable> & {
	restartTimer?: ReturnType<typeof setTimeout>;
};

export const AUTOSTART_CHECK_FILE = "/tmp/ceralive_restarted";

export const ceracoderExec = getCeracoderExec();
export const srtlaSendExec = `${setup.srtla_path ?? "/usr/bin"}/srtla_send`;
export const bcrptExec = `${setup.bcrpt_path ?? "/usr/bin"}/bcrpt`;

let streamingProcesses: Array<ChildProcess> = [];

function spawnStreamingLoop(
	command: string,
	args: Array<string>,
	cooldown: number,
	errCallback: (data: string) => void,
) {
	const childProcess = spawn(command, args, {
		stdio: ["inherit", "inherit", "pipe"],
	}) as ChildProcess;
	streamingProcesses.push(childProcess);

	if (errCallback) {
		childProcess.stderr.on("data", (data) => {
			const dataStr = data.toString("utf8");
			console.log(dataStr);
			errCallback(dataStr);
		});
	}

	childProcess.on("exit", () => {
		childProcess.restartTimer = setTimeout(() => {
			// remove the old process from the list
			removeProc(childProcess);

			spawnStreamingLoop(command, args, cooldown, errCallback);
		}, cooldown);
	});
}

let removeNetworkInterfacesChangeListener: (() => void) | undefined;

export async function startStream(
	pipeline: Pipeline,
	srtlaAddr: string,
	srtlaPort: number,
	streamid: string,
) {
	const config = getConfig();
	setBitrate(config);

	// Generate pipeline with overrides from config
	const pipelineFile = generatePipelineFile(pipeline, {
		bitrateOverlay: config.bitrate_overlay,
		audioCodec: config.acodec as "aac" | "opus" | undefined,
		audioDevice: config.asrc ? getAudioSrcId(config.asrc) : undefined,
		volume: 1.0,
	});

	if (pipeline.supportsAudio && config.asrc) {
		try {
			await asrcProbe(config.asrc);
		} catch (_err) {
			/* asrcProbe will reject if the user presses Stop before the audio interface is found
               at this point, the stream is already stopped, so we don't need to do anything here */
			return;
		}
	}
	spawnStreamingLoop(
		srtlaSendExec,
		[9000, srtlaAddr, srtlaPort, setup.ips_file],
		100,
		(err) => {
			let msg: string | undefined;
			if (err.match("Failed to establish any initial connections")) {
				msg = "Failed to connect to the SRTLA server. Retrying...";
			} else if (err.match("no available connections")) {
				msg = "All SRTLA connections failed. Trying to reconnect...";
			}
			if (msg) {
				notificationBroadcast("srtla", "error", msg, 5, true, false);
			}
		},
	);

	const ceracoderArgs = buildCeracoderArgsAndWriteConfig(
		config,
		pipelineFile,
		"127.0.0.1",
		9000,
		streamid,
		hasLowMtu(),
		true, // full override for start streaming
	);

	spawnStreamingLoop(ceracoderExec, ceracoderArgs, 2000, (err) => {
		let msg: string | undefined;
		if (err.match("gstreamer error from alsasrc0")) {
			msg = "Capture card error (audio). Trying to restart...";
		} else if (err.match("gstreamer error from v4l2src0")) {
			msg = "Capture card error (video). Trying to restart...";
		} else if (err.match("Pipeline stall detected")) {
			msg = "The input source has stalled. Trying to restart...";
		} else if (err.match("Failed to establish an SRT connection")) {
			if (!notificationExists("srtla")) {
				const reasonMatch = err.match(
					/Failed to establish an SRT connection: ([\w ]+)\./,
				);
				const reason = reasonMatch?.[1] ? ` (${reasonMatch[1]})` : "";
				msg = `Failed to connect to the SRT server${reason}. Retrying...`;
			}
		} else if (err.match(/The SRT connection.+, exiting/)) {
			if (!notificationExists("srtla")) {
				msg = "The SRT connection failed. Trying to reconnect...";
			}
		}
		if (msg) {
			notificationBroadcast("ceracoder", "error", msg, 5, true, false);
		}
	});
}

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
			console.error(err);
		}
		return;
	}

	if (removeNetworkInterfacesChangeListener) {
		removeNetworkInterfacesChangeListener();
	}

	const handleSrtlaIpAddresses = () => {
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

		setSrtlaIpList(srtlaIpList);

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
			console.error(err);
		}
		return;
	}
}

function removeProc(process: ChildProcess) {
	streamingProcesses = streamingProcesses.filter((p) => p !== process);
}

function stopProcess(process: ChildProcess) {
	if (process.restartTimer) {
		clearTimeout(process.restartTimer);
	}

	process.removeAllListeners("exit");
	process.on("exit", () => {
		removeProc(process);
	});

	if (process.exitCode === null && process.signalCode === null) {
		process.kill("SIGTERM");
		return false;
	}

	removeProc(process);
	return true;
}

const stopCheckInterval = 50;

function waitForAllProcessesToTerminate() {
	if (streamingProcesses.length === 0) {
		logger.info("stop: all processes terminated");
		updateStatus(false);

		periodicCheckForSoftwareUpdates();
	} else {
		for (const p of streamingProcesses) {
			logger.info(`stop: still waiting for ${p.spawnfile} to terminate...`);
		}
		setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
	}
}

function stopAll() {
	for (const p of streamingProcesses) {
		stopProcess(p);
	}
	setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
}

export function stop() {
	if (isAsrcProbeRejectResolved()) {
		clearAsrcProbeReject();

		if (streamingProcesses.length === 0) {
			updateStatus(false);
			return;
		}

		logger.error("stop: BUG?: found both an asrcProbe and running processes");
	}

	let foundCeracoder = false;

	for (const p of streamingProcesses) {
		p.removeAllListeners("exit");
		if (p.spawnfile.endsWith("ceracoder")) {
			foundCeracoder = true;
			logger.debug("stop: found the ceracoder process");

			if (!stopProcess(p)) {
				// if the process is active, wait for it to exit
				p.on("exit", () => {
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

export function setAutostart(value: boolean): void {
	if (typeof value !== "boolean") return;
	const config = getConfig();
	config.autostart = value;
	saveConfig();

	broadcastMsg("config", config);
}

export async function checkAutoStartStream() {
	// Don't autostart when restarting CeraLive after a software update or after a crash
	if (getConfig().autostart && !fs.existsSync(AUTOSTART_CHECK_FILE)) {
		autoStartStream();
	}
	fs.writeFileSync(AUTOSTART_CHECK_FILE, "");
}

export async function autoStartStream(): Promise<void> {
	if (getIsStreaming() || isUpdating()) {
		console.log("autostart aborted");
		return;
	}

	/* Populate the connections list file for srtla_send
       If no interfaces are available, retry later as we won't be able to stream yet */
	if (genSrtlaIpList().length < 1) {
		setTimeout(autoStartStream, 1000);
		return;
	}

	// The first await is used below, so we have to lock the status
	updateStatus(true);

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
		console.log("autostart failed: ");
		console.log(err);
		updateStatus(false);
		return;
	}

	try {
		// This will returned a cached address if the resolver is temporarily unavailable
		const srtlaAddr: string = await resolveSrtla(c.srtlaAddr);
		await startStream(c.pipeline, srtlaAddr, c.srtlaPort, c.streamid);
	} catch (err) {
		console.log("autostart failed, but will retry: ");
		console.log(err);
		setTimeout(autoStartStream, 1000);
		updateStatus(false);
		return;
	}

	console.log("autostart complete");
}
