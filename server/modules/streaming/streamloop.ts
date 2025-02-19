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

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

import type WebSocket from "ws";

import { logger } from "../../helpers/logger.ts";
import { getConfig } from "../config.ts";
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
import { getSocketSenderId } from "../ui/websocket-server.ts";
import { abortAsrcRetry, isAsrcRetryScheduled } from "./audio.ts";
import { genSrtlaIpList } from "./srtla.ts";
import {
	type ConfigParameters,
	getIsStreaming,
	startError,
	updateConfig,
	updateStatus,
} from "./streaming.ts";

type ChildProcess = ChildProcessByStdio<null, null, Readable> & {
	restartTimer?: ReturnType<typeof setTimeout>;
};

export const belacoderExec = `${setup.belacoder_path ?? "/usr/bin"}/belacoder`;
export const srtlaSendExec = `${setup.srtla_path ?? "/usr/bin"}/srtla_send`;

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

export function start(conn: WebSocket, params: ConfigParameters) {
	if (getIsStreaming() || isUpdating()) {
		sendStatus(conn);
		return;
	}

	const senderId = getSocketSenderId(conn);
	updateConfig(conn, params, (pipeline, srtlaAddr, srtlaPort, streamid) => {
		if (genSrtlaIpList() < 1) {
			startError(
				conn,
				"Failed to start, no available network connections",
				senderId,
			);
			return;
		}
		updateStatus(true);

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

		const config = getConfig();
		const belacoderArgs = [
			pipeline,
			"127.0.0.1",
			"9000",
			"-d",
			config.delay,
			"-b",
			setup.bitrate_file,
			"-l",
			config.srt_latency,
		];

		if (streamid !== "") {
			belacoderArgs.push("-s");
			belacoderArgs.push(streamid);
		}

		spawnStreamingLoop(belacoderExec, belacoderArgs, 2000, (err) => {
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
				notificationBroadcast("belacoder", "error", msg, 5, true, false);
			}
		});
	});
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
	if (isAsrcRetryScheduled()) {
		abortAsrcRetry();

		if (streamingProcesses.length === 0) {
			updateStatus(false);
			return;
		}

		logger.error("stop: BUG?: found both a timer and running processes");
	}

	let foundBelacoder = false;

	for (const p of streamingProcesses) {
		p.removeAllListeners("exit");
		if (p.spawnfile.endsWith("belacoder")) {
			foundBelacoder = true;
			logger.debug("stop: found the belacoder process");

			if (!stopProcess(p)) {
				// if the process is active, wait for it to exit
				p.on("exit", () => {
					logger.info("stop: belacoder terminated");
					stopAll();
				});
			} else {
				// if belacoder has terminated already, skip to the next step
				logger.info("stop: belacoder already terminated");
				stopAll();
			}
		}
	}

	if (!foundBelacoder) {
		logger.error("stop: BUG?: belacoder not found, terminating all processes");
		stopAll();
	}
}
