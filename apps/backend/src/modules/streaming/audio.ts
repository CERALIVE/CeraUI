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

/* Audio input selection and codec */
import fs from "node:fs";
import { readdirP } from "../../helpers/files.ts";
import { logger } from "../../helpers/logger.ts";
import { readTextFile } from "../../helpers/text-files.ts";
import { AUDIO_SOURCE_POLL_DELAY } from "../../helpers/timing-constants.ts";

import { getConfig } from "../config.ts";
import { setup } from "../setup.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import {
	type AudioDeviceWatcher,
	createAudioDeviceWatcher,
} from "./audio-watcher.ts";
import { AUDIO_PROBE_TIMEOUT_MS } from "./constants.ts";

const deviceDir = setup.sound_device_dir ?? "/sys/class/sound";

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

export async function updateAudioDevices(dir: string = deviceDir) {
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

	const devices = await readdirP(dir);
	const list: Record<string, true> = {};

	for (const d of devices) {
		// Only inspect cards
		if (!d.match(/^card/)) continue;

		// Get the card's ID
		const id = ((await readTextFile(`${dir}/${d}/id`)) ?? "").trim();

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

	// A hotplug re-enumeration may have brought in the device a stream start is
	// waiting on — wake the pending probe so it re-checks now instead of after
	// the next poll tick, beating the QW-J timeout (QW-E ↔ QW-J interaction).
	asrcProbeWake?.();
}

let asrcProbeReject: ((err: Error) => void) | undefined;
let asrcProbeWake: (() => void) | undefined;

export function isAsrcProbeRejectResolved() {
	return asrcProbeReject !== undefined;
}

export function clearAsrcProbeReject() {
	asrcProbeReject?.();
	asrcProbeReject = undefined;
	asrcProbeWake = undefined;
}

export class AudioProbeTimeoutError extends Error {
	constructor(public readonly device: string) {
		super(
			`Audio device '${device}' did not appear within ${AUDIO_PROBE_TIMEOUT_MS}ms`,
		);
		this.name = "AudioProbeTimeoutError";
	}
}

export async function asrcProbe(asrc: string): Promise<string> {
	let audioSrcId: string | undefined = audioDevices[asrc];
	if (audioSrcId) return audioSrcId;

	return new Promise((res: (id: string) => void, rej: (err: Error) => void) => {
		// Cancel any prior pending probe before starting a new one
		clearAsrcProbeReject();
		asrcProbeReject = () => {
			rej(new AudioProbeTimeoutError(asrc));
		};

		// Set timeout for audio device probe (QW-J)
		const timeoutHandle = setTimeout(() => {
			if (asrcProbeReject) {
				asrcProbeReject();
				asrcProbeReject = undefined;
			}
		}, AUDIO_PROBE_TIMEOUT_MS);

		const poll = async () => {
			while (asrcProbeReject) {
				audioSrcId = audioDevices[asrc];
				if (audioSrcId) {
					clearTimeout(timeoutHandle);
					asrcProbeReject = undefined;
					res(audioSrcId);
					return;
				}
				const config = getConfig();
				const msg = `Selected audio input '${config.asrc}' is unavailable. Waiting for it before starting the stream...`;
				notificationBroadcast("asrc_not_found", "error", msg, 2, true, false);

				// Sleep one poll interval, but wake early if a hotplug re-enumeration
				// signals a device-list change (asrcProbeWake from updateAudioDevices).
				await new Promise<void>((r) => {
					const sleepHandle = setTimeout(r, AUDIO_SOURCE_POLL_DELAY);
					asrcProbeWake = () => {
						clearTimeout(sleepHandle);
						asrcProbeWake = undefined;
						r();
					};
				});
			}
			// If the loop exited, then rej() was already called externally. Nothing left to do
			asrcProbeWake = undefined;
			clearTimeout(timeoutHandle);
		};

		poll();
	});
}

let audioWatcher: AudioDeviceWatcher | undefined;

export function startAudioDeviceWatcher(isStreaming?: () => boolean) {
	if (audioWatcher) return audioWatcher;
	const opts = {
		dir: deviceDir,
		onChange: () => void updateAudioDevices(),
		...(isStreaming ? { isStreaming } : {}),
	};
	audioWatcher = createAudioDeviceWatcher(opts);
	return audioWatcher;
}

export function stopAudioDeviceWatcher() {
	audioWatcher?.stop();
	audioWatcher = undefined;
}
