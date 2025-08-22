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

import { readdirP } from "../../helpers/files.ts";
import { logger } from "../../helpers/logger.ts";
import { readTextFile, writeTextFile } from "../../helpers/text-files.ts";

import { getConfig } from "../config.ts";
import { setup } from "../setup.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

const deviceDir = setup.sound_device_dir ?? "/sys/class/sound";

const alsaSrcPattern = /alsasrc device=[A-Za-z0-9:=]+/;
const alsaPipelinePattern = /alsasrc device=[A-Za-z0-9:]+(.|\s)*?mux\. *\s?/;

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
};
if (setup.hw === "rk3588") {
	Object.assign(audioSrcAliases, {
		rockchiphdmiin: "HDMI",
		rockchipes8388: "Analog in",
	});
}

// Create reverse lookup for performance
const audioSrcReverseAliases: Record<string, string> = {};
for (const id in audioSrcAliases) {
	audioSrcReverseAliases[audioSrcAliases[id]] = id;
}

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

export async function replaceAudioSettings(
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

export function getAudioSrcId(name: string) {
	return audioSrcReverseAliases[name] ?? name;
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
	logger.debug("audio devices:", audioDevices);

	broadcastMsg("status", { asrcs: Object.keys(audioDevices) });
}

let asrcProbeReject: (() => void) | undefined;

export function isAsrcProbeRejectResolved() {
	return asrcProbeReject !== undefined;
}

export function clearAsrcProbeReject() {
	asrcProbeReject?.();
	asrcProbeReject = undefined;
}

export async function asrcProbe(asrc: string): Promise<string> {
	let audioSrcId: string | undefined = audioDevices[asrc];
	if (audioSrcId) return audioSrcId;

	return new Promise((res: (id: string) => void, rej: () => void) => {
		// Cancel any prior pending probe before starting a new one
		clearAsrcProbeReject();
		asrcProbeReject = rej;

		const poll = async () => {
			while (asrcProbeReject === rej) {
				audioSrcId = audioDevices[asrc];
				if (audioSrcId) {
					asrcProbeReject = undefined;
					res(audioSrcId);
					return;
				}
				const config = getConfig();
				const msg = `Selected audio input '${config.asrc}' is unavailable. Waiting for it before starting the stream...`;
				notificationBroadcast("asrc_not_found", "error", msg, 2, true, false);

				// sleep for one second
				await new Promise<void>((r) => {
					setTimeout(r, 1000);
				});
			}
			// If the loop exited, then rej() was already called externally. Nothing left to do
		};

		poll();
	});
}
