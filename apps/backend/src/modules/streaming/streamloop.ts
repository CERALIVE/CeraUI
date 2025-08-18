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

import {type ChildProcessByStdio, spawn} from "node:child_process";
import type {Readable} from "node:stream";

import type WebSocket from "ws";

import {isLocalIp} from "../../helpers/ip-addresses.ts";
import {logger} from "../../helpers/logger.ts";

import {getConfig, saveConfig} from "../config.ts";
import {onNetworkInterfacesChange} from "../network/network-interfaces.ts";
import {setup} from "../setup.ts";
import {
    isUpdating,
    periodicCheckForSoftwareUpdates,
} from "../system/software-updates.ts";
import {
    notificationBroadcast,
    notificationExists,
} from "../ui/notifications.ts";
import {sendStatus} from "../ui/status.ts";
import {broadcastMsg, getSocketSenderId} from "../ui/websocket-server.ts";

import {
    genSrtlaIpListForLocalIpAddress,
    genSrtlaIpList,
    restartSrtla,
    setSrtlaIpList, resolveSrtla,
} from "./srtla.ts";
import {
    type ConfigParameters,
    getIsStreaming,
    startError,
    updateConfig,
    updateStatus, validateConfig,
} from "./streaming.ts";
import {hasLowMtu} from "./bcrpt.ts";
import {type Pipeline, removeBitrateOverlay} from "./pipelines.ts";
import {setBitrate} from "./encoder.ts";
import {
    asrcProbe,
    clearAsrcProbeReject,
    DEFAULT_AUDIO_ID,
    getAudioSrcId,
    isAsrcProbeRejectResolved,
    replaceAudioSettings
} from "./audio.ts";
import fs from "fs";

type ChildProcess = ChildProcessByStdio<null, null, Readable> & {
    restartTimer?: ReturnType<typeof setTimeout>;
};

export const AUTOSTART_CHECK_FILE = '/tmp/belaui_restarted';

export const belacoderExec = `${setup.belacoder_path ?? "/usr/bin"}/belacoder`;
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

export async function startStream(pipeline: Pipeline, srtlaAddr: string, srtlaPort: number, streamid: string) {
    const config = getConfig();
    setBitrate(config);

    // remove the bitrate overlay unless enabled in the config
    let pipelineFile: string | undefined = pipeline.path;
    if (!config.bitrate_overlay) {
        pipelineFile = await removeBitrateOverlay(pipelineFile);
        if (!pipelineFile) throw ("failed to generate the pipeline file - bitrate overlay");
    }
    // replace the audio source and codec
    let audioCodec = pipeline.acodec ? config.acodec : undefined;
    let audioSrcId = pipeline.asrc ? getAudioSrcId(config.asrc!) : DEFAULT_AUDIO_ID;
    pipelineFile = await replaceAudioSettings(pipelineFile, audioSrcId, audioCodec);
    if (!pipelineFile) {
        throw("failed to generate the pipeline file - audio settings");
    }

    if (pipeline.asrc) {
        try {
            await asrcProbe(config.asrc!);
        } catch (err) {
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

    const belacoderArgs = [
        pipelineFile,
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
}


export async function start(conn: WebSocket, params: ConfigParameters): Promise<void> {
    if (getIsStreaming() || isUpdating()) {
        sendStatus(conn);
        return;
    }

    updateStatus(true);
    const senderId = getSocketSenderId(conn);

    let c: { pipeline: Pipeline; srtlaAddr: string; srtlaPort: number; streamid: string };
    try {
        c = await updateConfig(conn, params);
    } catch (err) {
        if (typeof err === 'string') {
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
        if (typeof err === 'string') {
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
        clearAsrcProbeReject()

        if (streamingProcesses.length === 0) {
            updateStatus(false);
            return;
        }

        logger.error("stop: BUG?: found both an asrcProbe and running processes");
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

export function setAutostart(value: boolean): void {
    if (typeof value !== 'boolean') return;
    const config = getConfig()
    config.autostart = value;
    saveConfig();

    broadcastMsg('config', config);
}

export async function checkAutoStartStream(){
    // Don't autostart when restarting belaUI after a software update or after a crash
    if (getConfig().autostart && !fs.existsSync(AUTOSTART_CHECK_FILE)) {
        autoStartStream()
    }
    fs.writeFileSync(AUTOSTART_CHECK_FILE, '');
}

export async function autoStartStream(): Promise<void> {
    if (getIsStreaming() || isUpdating()) {
        console.log('autostart aborted');
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
    let c: { pipeline: Pipeline; srtlaAddr: string; srtlaPort: number; streamid: string };
    try {
        c = await validateConfig(config);
    } catch (err) {
        console.log('autostart failed: ');
        console.log(err);
        updateStatus(false);
        return;
    }

    try {
        // This will returned a cached address if the resolver is temporarily unavailable
        const srtlaAddr: string = await resolveSrtla(c.srtlaAddr);
        await startStream(c.pipeline, srtlaAddr, c.srtlaPort, c.streamid);
    } catch (err) {
        console.log('autostart failed, but will retry: ');
        console.log(err);
        setTimeout(autoStartStream, 1000);
        updateStatus(false);
        return;
    }

    console.log('autostart complete');
}
