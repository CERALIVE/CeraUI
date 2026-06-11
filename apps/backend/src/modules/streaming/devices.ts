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

// Hotplug input discovery (Task 34). Scans v4l2 capture nodes + the unified
// audio device list (Task 13), de-duplicates by display name, and broadcasts a
// `devices` payload on every add/remove. Drives the cerastream hotplug picker
// and the live `switch-input` RPC. Engine-agnostic: the v4l2 scan is the source
// on both a real device and in dev/e2e (where modprobe v4l2loopback is real),
// while the actual gapless switch is delegated to the cerastream engine over IPC
// only when streaming on cerastream. Every effectful collaborator is injected so
// the registry is exercisable against an in-memory fixture with no hardware.

import fs from "node:fs";
import { readdir } from "node:fs/promises";

import {
	type CaptureDevice,
	type DeviceKind,
	type DevicesMessage,
	type StreamingEngineKind,
	SWITCH_INPUT_ERRORS,
	type SwitchInputOutput,
} from "@ceraui/rpc/schemas";

import { logger as defaultLogger } from "../../helpers/logger.ts";
import { readTextFile } from "../../helpers/text-files.ts";
import { getAudioDevices } from "./audio.ts";
import {
	VIDEO_HOTPLUG_DEBOUNCE_MS,
	VIDEO_HOTPLUG_POLL_INTERVAL_MS,
} from "./constants.ts";
import { getConfiguredEngine } from "./streaming-engine.ts";
import { getStreamingProcesses } from "./streamloop/process-runner.ts";

const VIDEO_DIR = "/sys/class/video4linux";
const DEV_DIR = "/dev";
const VIDEO_CARD_RE = /^video\d+$/;

// Audio sentinels from audio.ts that are pipeline pseudo-sources, not devices.
const AUDIO_PSEUDO_SOURCES = new Set(["No audio", "Pipeline default"]);

export interface DeviceRegistryDeps {
	listVideoCards: () => Promise<string[]>;
	readCardName: (card: string) => Promise<string | undefined>;
	getAudioSources: () => Record<string, string>;
	getEngine: () => StreamingEngineKind;
	isStreaming: () => boolean;
	engineSwitch: (inputId: string) => Promise<void>;
	broadcast: (type: string, data: unknown) => void;
	watch: typeof fs.watch;
	now: () => number;
	debounceMs: number;
	pollMs: number;
	logger: Pick<typeof defaultLogger, "debug" | "warn" | "error">;
}

export interface DeviceRegistry {
	scan(): Promise<CaptureDevice[]>;
	getMessage(): DevicesMessage;
	getDevices(): CaptureDevice[];
	getActiveInput(): string | undefined;
	rescan(): Promise<DevicesMessage>;
	switchInput(inputId: string): Promise<SwitchInputOutput>;
	start(): void;
	stop(): void;
}

/**
 * Group a discovered video node from its display name. The cerastream engine
 * supplies a richer kind on a real device; this heuristic only drives picker
 * grouping in the v4l2-scan path, so a miss is cosmetic (lands in "other").
 */
export function deriveKind(name: string): DeviceKind {
	const n = name.toLowerCase();
	if (/hdmi/.test(n)) return "hdmi";
	if (/rtmp|srt|ingest|network/.test(n)) return "network";
	if (/test|loopback|dummy|pattern/.test(n)) return "test";
	if (/usb|uvc|cam|webcam|c4k|camlink|decklink/.test(n)) return "usb";
	return "other";
}

/** Pure: collapse a v4l2 scan + audio map into the deduped device list. */
export function buildDeviceList(
	videoCards: Array<{ card: string; name: string }>,
	audioSources: Record<string, string>,
): CaptureDevice[] {
	const devices: CaptureDevice[] = [];
	const seenNames = new Set<string>();
	for (const { card, name } of videoCards) {
		if (!VIDEO_CARD_RE.test(card)) continue;
		const display = name.trim() || card;
		// Cameras expose multiple /dev/videoN nodes under one name (capture +
		// metadata); the picker wants one entry per physical source.
		if (seenNames.has(display)) continue;
		seenNames.add(display);
		devices.push({
			input_id: card,
			device_path: `/dev/${card}`,
			display_name: display,
			media_class: "video",
			kind: deriveKind(display),
		});
	}
	for (const [name, id] of Object.entries(audioSources)) {
		if (AUDIO_PSEUDO_SOURCES.has(name)) continue;
		devices.push({
			input_id: `audio:${id}`,
			device_path: `alsa:${id}`,
			display_name: name,
			media_class: "audio",
			kind: "audio",
		});
	}
	return devices;
}

function defaultEngineSwitch(inputId: string): Promise<void> {
	// Lazy import keeps the cerastream control-IPC graph out of this module's
	// load path; it is only needed for a real on-device gapless switch.
	return import("./cerastream-backend.ts").then(({ cerastreamBackend }) =>
		cerastreamBackend
			.switchInput({ input_id: inputId, mode: "manual" })
			.then(() => undefined),
	);
}

function defaultDeps(): DeviceRegistryDeps {
	return {
		listVideoCards: () => readdir(VIDEO_DIR).catch(() => []),
		readCardName: (card) => readTextFile(`${VIDEO_DIR}/${card}/name`),
		getAudioSources: getAudioDevices,
		getEngine: getConfiguredEngine,
		isStreaming: () => getStreamingProcesses().length > 0,
		engineSwitch: defaultEngineSwitch,
		broadcast: (type, data) => {
			void import("../ui/websocket-server.ts").then(({ broadcastMsg }) =>
				broadcastMsg(type, data),
			);
		},
		watch: fs.watch,
		now: () => performance.now(),
		debounceMs: VIDEO_HOTPLUG_DEBOUNCE_MS,
		pollMs: VIDEO_HOTPLUG_POLL_INTERVAL_MS,
		logger: defaultLogger,
	};
}

export function createDeviceRegistry(
	overrides: Partial<DeviceRegistryDeps> = {},
): DeviceRegistry {
	const deps: DeviceRegistryDeps = { ...defaultDeps(), ...overrides };

	let devices: CaptureDevice[] = [];
	let activeInput: string | undefined;
	let lastSerialized = "";
	let debounceHandle: ReturnType<typeof setTimeout> | undefined;
	let pollHandle: ReturnType<typeof setInterval> | undefined;
	let devWatcher: fs.FSWatcher | undefined;
	let stopped = false;

	async function scan(): Promise<CaptureDevice[]> {
		const cards = (await deps.listVideoCards()).sort();
		const named: Array<{ card: string; name: string }> = [];
		for (const card of cards) {
			if (!VIDEO_CARD_RE.test(card)) continue;
			const name = (await deps.readCardName(card)) ?? card;
			named.push({ card, name });
		}
		return buildDeviceList(named, deps.getAudioSources());
	}

	function getMessage(): DevicesMessage {
		return {
			engine: deps.getEngine(),
			...(activeInput ? { active_input: activeInput } : {}),
			devices,
		};
	}

	function applyAndBroadcast(next: CaptureDevice[]): DevicesMessage {
		devices = next;
		const message = getMessage();
		const serialized = JSON.stringify(message);
		if (serialized !== lastSerialized) {
			lastSerialized = serialized;
			deps.broadcast("devices", message);
		}
		return message;
	}

	async function rescan(): Promise<DevicesMessage> {
		try {
			return applyAndBroadcast(await scan());
		} catch (err) {
			deps.logger.warn("device discovery: scan failed", { err });
			return getMessage();
		}
	}

	async function switchInput(inputId: string): Promise<SwitchInputOutput> {
		const started = deps.now();
		// Re-scan fresh so a device yanked since the last broadcast is caught.
		let fresh: CaptureDevice[];
		try {
			fresh = await scan();
		} catch (err) {
			deps.logger.error("device switch: rescan failed", { err });
			return { success: false, error: SWITCH_INPUT_ERRORS.SWITCH_FAILED };
		}
		applyAndBroadcast(fresh);

		const target = fresh.find((d) => d.input_id === inputId);
		if (!target) {
			return {
				success: false,
				error: SWITCH_INPUT_ERRORS.SOURCE_LOST,
				...(activeInput ? { active_input: activeInput } : {}),
			};
		}

		try {
			if (deps.getEngine() === "cerastream" && deps.isStreaming()) {
				await deps.engineSwitch(inputId);
			}
		} catch (err) {
			deps.logger.error("device switch: engine switch failed", { err });
			return {
				success: false,
				error: SWITCH_INPUT_ERRORS.SWITCH_FAILED,
				...(activeInput ? { active_input: activeInput } : {}),
			};
		}

		activeInput = inputId;
		const gap_ms = Math.max(0, Math.round(deps.now() - started));
		applyAndBroadcast(fresh);
		return { success: true, active_input: inputId, gap_ms };
	}

	function fireDebounced(): void {
		if (debounceHandle) clearTimeout(debounceHandle);
		debounceHandle = setTimeout(() => {
			debounceHandle = undefined;
			void rescan();
		}, deps.debounceMs);
	}

	function start(): void {
		stopped = false;
		void rescan();
		try {
			devWatcher = deps.watch(DEV_DIR, (_event, filename) => {
				if (!filename || String(filename).startsWith("video")) fireDebounced();
			});
			devWatcher.on("error", (err: unknown) => {
				deps.logger.warn("device discovery: dev watch error", { err });
				devWatcher?.close();
				devWatcher = undefined;
			});
		} catch (err) {
			deps.logger.warn("device discovery: cannot watch /dev", { err });
		}
		// The poll is the reliable detector (sysfs/devtmpfs inotify is flaky);
		// fs.watch above is only the fast path.
		pollHandle = setInterval(() => {
			if (!stopped) void rescan();
		}, deps.pollMs);
	}

	function stop(): void {
		stopped = true;
		if (debounceHandle) {
			clearTimeout(debounceHandle);
			debounceHandle = undefined;
		}
		if (pollHandle) {
			clearInterval(pollHandle);
			pollHandle = undefined;
		}
		devWatcher?.close();
		devWatcher = undefined;
	}

	return {
		scan,
		getMessage,
		getDevices: () => devices,
		getActiveInput: () => activeInput,
		rescan,
		switchInput,
		start,
		stop,
	};
}

// Process-wide singleton wired with the real collaborators; main.ts starts it.
export const deviceRegistry: DeviceRegistry = createDeviceRegistry();

export function startDeviceDiscovery(): void {
	deviceRegistry.start();
}

export function getDevicesMessage(): DevicesMessage {
	return deviceRegistry.getMessage();
}
