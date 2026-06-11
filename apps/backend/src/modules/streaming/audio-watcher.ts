/*
    CeraUI - web UI for the CeraLive project
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

// Live audio-device hotplug watcher (QW-E). inotify (fs.watch) on the sound
// device directory is the primary mechanism; a streaming-gated poll loop is the
// degraded fallback when fs.watch is unavailable. All effectful surface (the
// watch fn, timers via debounce/poll knobs, the stream-state probe) is injected
// so the loop is exercisable against a tmpdir fixture without real hardware.

import fs from "node:fs";

import { logger } from "../../helpers/logger.ts";
import {
	AUDIO_HOTPLUG_DEBOUNCE_MS,
	AUDIO_HOTPLUG_POLL_INTERVAL_MS,
} from "./constants.ts";

export interface AudioDeviceWatcherOptions {
	dir: string;
	onChange: () => void;
	isStreaming?: () => boolean;
	debounceMs?: number;
	pollIntervalMs?: number;
	watch?: typeof fs.watch;
}

export interface AudioDeviceWatcher {
	stop: () => void;
	isPolling: () => boolean;
}

export function createAudioDeviceWatcher(
	opts: AudioDeviceWatcherOptions,
): AudioDeviceWatcher {
	const {
		dir,
		onChange,
		isStreaming,
		debounceMs = AUDIO_HOTPLUG_DEBOUNCE_MS,
		pollIntervalMs = AUDIO_HOTPLUG_POLL_INTERVAL_MS,
		watch = fs.watch,
	} = opts;

	let debounceHandle: ReturnType<typeof setTimeout> | undefined;
	let pollHandle: ReturnType<typeof setInterval> | undefined;
	let fsWatcher: fs.FSWatcher | undefined;
	let stopped = false;

	const fireDebounced = () => {
		if (debounceHandle) clearTimeout(debounceHandle);
		debounceHandle = setTimeout(() => {
			debounceHandle = undefined;
			onChange();
		}, debounceMs);
	};

	const startPollingFallback = () => {
		if (stopped || pollHandle) return;
		logger.warn(
			`audio hotplug: fs.watch unavailable on ${dir}; polling every ${pollIntervalMs}ms while streaming`,
		);
		pollHandle = setInterval(() => {
			if (!isStreaming || isStreaming()) onChange();
		}, pollIntervalMs);
	};

	try {
		fsWatcher = watch(dir, () => fireDebounced());
		fsWatcher.on("error", (err: unknown) => {
			logger.warn(`audio hotplug: watch error on ${dir}:`, err);
			fsWatcher?.close();
			fsWatcher = undefined;
			startPollingFallback();
		});
		logger.debug(`audio hotplug: watching ${dir} for device changes`);
	} catch (err) {
		logger.warn(`audio hotplug: cannot watch ${dir}:`, err);
		startPollingFallback();
	}

	return {
		stop() {
			stopped = true;
			if (debounceHandle) {
				clearTimeout(debounceHandle);
				debounceHandle = undefined;
			}
			if (pollHandle) {
				clearInterval(pollHandle);
				pollHandle = undefined;
			}
			fsWatcher?.close();
			fsWatcher = undefined;
		},
		isPolling() {
			return pollHandle !== undefined;
		},
	};
}
