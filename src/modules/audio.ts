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

/* Audio input selection and codec */
import fs from "node:fs";

import WebSocket from "ws";

import { readdirP } from "../helpers/files.ts";

import { setup } from "./setup.ts";
import { getConfig } from "./config.ts";
import { broadcastMsg } from "./websocket-server.ts";
import { notificationBroadcast } from "./notifications.ts";
import { resolveSrtla } from "./srtla.ts";
import { startError } from "./streaming.ts";
import { readTextFile, writeTextFile } from "./text-files.ts";

const deviceDir = setup.sound_device_dir ?? "/sys/class/sound";

const alsaSrcPattern = /alsasrc device=[A-Za-z0-9:=]+/;
const alsaPipelinePattern = /alsasrc device=[A-Za-z0-9:]+(.|[\s])*?mux\. *\s?/;

const audioCodecPattern = /voaacenc\s+bitrate=(\d+)\s+!\s+aacparse\s+!/;
export const audioCodecs: Record<string, string> = {
	opus: "Opus (better quality)",
	aac: "AAC (backwards compatibility)",
};

const NO_AUDIO_ID = "No audio";
export const DEFAULT_AUDIO_ID = "Pipeline default";
const audioSrcAliases: Record<string, string> = {
	C4K: "Cam Link 4K",
	usbaudio: "USB audio",
	rockchiphdmiin: "HDMI",
	rockchipes8388: "Analog in",
};

let audioDevices: Record<string, string> = {};
addAudioCardById(audioDevices, NO_AUDIO_ID);
addAudioCardById(audioDevices, DEFAULT_AUDIO_ID);

export function getAudioDevices() {
	return audioDevices;
}

export function pipelineGetAudioProps(path: string) {
	const contents = fs.readFileSync(path, "utf8");
	return {
		asrc: contents.match(alsaPipelinePattern) != null,
		acodec: contents.match(audioCodecPattern) != null,
	};
}

async function replaceAudioSettings(
	pipelineFile: string,
	cardId: string,
	codec?: string,
) {
	let pipeline = await readTextFile(pipelineFile);
	if (pipeline === undefined) return;

	if (cardId && cardId !== DEFAULT_AUDIO_ID) {
		if (cardId === NO_AUDIO_ID) {
			pipeline = pipeline.replace(alsaPipelinePattern, "");
		} else {
			pipeline = pipeline.replace(
				alsaSrcPattern,
				`alsasrc device="hw:${cardId}"`,
			);
		}
	}

	if (codec === "opus") {
		const br = pipeline.match(audioCodecPattern);
		if (br) {
			pipeline = pipeline.replace(
				audioCodecPattern,
				`audioresample quality=10 sinc-filter-mode=1 ! opusenc bitrate=${br[1]} ! opusparse !`,
			);
		}
	}

	const pipelineTmp = "/tmp/belacoder_pipeline";
	if (!(await writeTextFile(pipelineTmp, pipeline))) return;

	return pipelineTmp;
}

function getAudioSrcName(id: string) {
	const name = audioSrcAliases[id];
	if (name) return name;
	return id;
}

function addAudioCardById(list: Record<string, string>, id: string) {
	const name = getAudioSrcName(id);
	list[name] = id;
}

export async function updateAudioDevices() {
	// Ignore the onboard audio cards
	const exclude = [
		"tegrahda",
		"tegrasndt210ref",
		"rockchipdp0",
		"rockchiphdmi0",
		"rockchiphdmi1",
		"rockchiphdmi2",
		"rockchiphdmiind",
		"rockchipes8316",
	];
	// Devices to show at the top of the list
	const priority = [
		"HDMI",
		"rockchiphdmiin",
		"rockchipes8388",
		"C4K",
		"usbaudio",
	];

	const devices = await readdirP(deviceDir);
	const list: Record<string, true> = {};

	for (const d of devices) {
		// Only inspect cards
		if (!d.match(/^card/)) continue;

		// Get the card's ID
		const id = ((await readTextFile(`${deviceDir}/${d}/id`)) ?? "").trim();

		// Skip over the IDs known not to be valid audio inputs
		if (exclude.includes(id)) continue;

		list[id] = true;
	}
	// First add any priority cards found
	const sortedList = {};
	for (const id of priority) {
		if (list[id]) addAudioCardById(sortedList, id);
		delete list[id];
	}

	// Then add the remaining cards in alphabetical order
	for (const id of Object.keys(list).sort()) {
		addAudioCardById(sortedList, id);
	}

	// Always add 'no audio' and default audio options
	addAudioCardById(sortedList, NO_AUDIO_ID);
	addAudioCardById(sortedList, DEFAULT_AUDIO_ID);

	audioDevices = sortedList;
	console.log("audio devices:");
	console.log(audioDevices);

	broadcastMsg("status", { asrcs: Object.keys(audioDevices) });
}

export function asrcProbe(asrc: string) {
	const audioSrcId = audioDevices[asrc];
	if (!audioSrcId) {
		const msg = `Selected audio input '${asrc}' is unavailable. Waiting for it before starting the stream...`;
		notificationBroadcast("asrc_not_found", "warning", msg, 2, true, false);
	}

	return audioSrcId;
}

export async function pipelineSetAsrc(
	pipelineFilePath: string,
	audioSrcId: string,
	audioCodec?: string,
) {
	const pipelineFile = await replaceAudioSettings(
		pipelineFilePath,
		audioSrcId,
		audioCodec,
	);
	if (!pipelineFile) {
		// FIXME: conn is not defined here!
		startError(
			undefined as unknown as WebSocket,
			"failed to generate the pipeline file - audio settings",
		);
	}
	return pipelineFile;
}

let asrcRetryTimer: NodeJS.Timeout | undefined;

export function isAsrcRetryScheduled() {
	return asrcRetryTimer !== undefined;
}

export function abortAsrcRetry() {
	if (asrcRetryTimer) {
		clearTimeout(asrcRetryTimer);
		asrcRetryTimer = undefined;
	}
}

export function asrcScheduleRetry(
	pipelineFile: string,
	callback: (pipelineFile: string, srtlaAddr: string) => void,
	conn: WebSocket,
) {
	asrcRetryTimer = setTimeout(function () {
		asrcRetry(pipelineFile, callback, conn);
	}, 1000);
}

async function asrcRetry(
	pipelineFilePath: string,
	callback: (pipelineFile: string, srtlaAddr: string) => void,
	conn: WebSocket,
) {
	asrcRetryTimer = undefined;

	const config = getConfig();

	const audioSrcId = asrcProbe(config.asrc ?? "");
	if (audioSrcId) {
		const pipelineFile = await pipelineSetAsrc(
			pipelineFilePath,
			audioSrcId,
			config.acodec,
		);
		if (!pipelineFile) return;

		if (!config.srtla_addr) return;
		const srtlaAddr = await resolveSrtla(config.srtla_addr, conn);
		if (!srtlaAddr) return;

		callback(pipelineFile, srtlaAddr);
	} else {
		asrcScheduleRetry(pipelineFilePath, callback, conn);
	}
}
