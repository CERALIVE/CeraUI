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

import type { AudioSource } from "@ceraui/rpc/schemas";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import { readdirP } from "../../helpers/files.ts";
import { logger } from "../../helpers/logger.ts";
import { readTextFile } from "../../helpers/text-files.ts";
import { AUDIO_SOURCE_POLL_DELAY } from "../../helpers/timing-constants.ts";

import { getConfig } from "../config.ts";
import { setup } from "../setup.ts";
import { isRealDevice } from "../system/device-detection.ts";
import { getHardwareKindCached } from "../system/hardware-kind.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import type { AudioDeviceIdentity } from "./audio-naming.ts";
import {
	parseAsoundCards,
	resolveAudioIdentities,
	resolveAudioLabels,
} from "./audio-naming.ts";
import {
	type AudioDeviceWatcher,
	createAudioDeviceWatcher,
} from "./audio-watcher.ts";
import { refreshResolvedAsrcPreview } from "./auto-audio.ts";
import { AUDIO_PROBE_TIMEOUT_MS } from "./constants.ts";
import { reportActiveAudioSource } from "./lifecycle-indicators.ts";
import { getEngineAudioDevices } from "./sources.ts";
import { getStreamingProcesses } from "./streamloop/process-runner.ts";

const deviceDir = setup.sound_device_dir ?? "/sys/class/sound";
const PROC_ASOUND_CARDS = "/proc/asound/cards";

const NO_AUDIO_ID = "No audio";
export const DEFAULT_AUDIO_ID = "Pipeline default";

// "No audio" / "Pipeline default" are pipeline pseudo-sources, not real capture
// devices — a start must never probe (nor probe-fail) on them.
const PSEUDO_AUDIO_SOURCES: ReadonlySet<string> = new Set([
	NO_AUDIO_ID,
	DEFAULT_AUDIO_ID,
]);

export function isPseudoAudioSource(asrc: string): boolean {
	return PSEUDO_AUDIO_SOURCES.has(asrc);
}

export function isSelectedAudioLost(
	asrc: string | undefined,
	available: readonly string[],
): boolean {
	if (!asrc) return false;
	if (asrc === AUDIO_SOURCE_AUTO || isPseudoAudioSource(asrc)) return false;
	return !available.includes(asrc);
}

export type AudioMode = "none" | "default" | "device";

export interface AudioModeSelection {
	mode: AudioMode;
	device?: string;
}

// Map an operator audio pick onto the engine's `audio.mode` discriminator so a
// pseudo-source is never leaked into `audio.device` as a bogus ALSA id: "No
// audio" is an explicit video-only stream, "Pipeline default" hands sourcing to
// the engine, a network-embedded source rides the engine default, and any real
// selection carries the resolved ALSA card id.
export function resolveAudioMode(
	asrc: string,
	embeddedAudioActive: boolean,
): AudioModeSelection {
	if (asrc === NO_AUDIO_ID) return { mode: "none" };
	if (asrc === DEFAULT_AUDIO_ID) return { mode: "default" };
	if (embeddedAudioActive) return { mode: "default" };
	return { mode: "device", device: toAlsaCaptureDevice(getAudioSrcId(asrc)) };
}

// The engine passes `audio.device` straight to `alsasrc device=`, which needs a
// real ALSA device string, not a bare card id: `alsasrc device="usbaudio"` never
// opens and the engine rejects the start with `-32602 audio-device-unavailable`.
// Wrap a bare card id as `hw:CARD=<id>` (the engine's own per-source default form);
// a value that already carries an ALSA selector (`hw:0`, `hw:CARD=x`, `plughw:…`)
// is passed through unchanged, so the transform is idempotent.
function toAlsaCaptureDevice(cardId: string): string {
	if (cardId.includes(":") || cardId.includes("=")) return cardId;
	return `hw:CARD=${cardId}`;
}
const BASE_AUDIO_SRC_ALIASES: Readonly<Record<string, string>> = {
	C4K: "Cam Link 4K",
	usbaudio: "USB audio",
};
const RK3588_AUDIO_SRC_ALIASES: Readonly<Record<string, string>> = {
	rockchiphdmiin: "HDMI",
	rockchipes8388: "Analog in",
};

// Resolved at CALL time (not import time): the rk3588 label aliases are added
// only when the LIVE-resolved kind is rk3588, so a mismatched setup.hw image no
// longer stamps rk3588 audio labels onto another board. On an actual rk3588 board
// the table is byte-identical to the previous import-time build.
function getAudioSrcAliases(): Record<string, string> {
	if (getHardwareKindCached() === "rk3588") {
		return { ...BASE_AUDIO_SRC_ALIASES, ...RK3588_AUDIO_SRC_ALIASES };
	}
	return { ...BASE_AUDIO_SRC_ALIASES };
}

function getAudioSrcReverseAliases(): Record<string, string> {
	const reverse: Record<string, string> = {};
	const aliases = getAudioSrcAliases();
	for (const id in aliases) {
		const alias = aliases[id];
		if (alias !== undefined) reverse[alias] = id;
	}
	return reverse;
}

let audioDevices: Record<string, string> = {};
addAudioCardById(audioDevices, NO_AUDIO_ID);
addAudioCardById(audioDevices, DEFAULT_AUDIO_ID);

// Dev/e2e seam merged into the list WITHOUT touching the real /sys/class/sound
// scan; injected at boot under shouldUseMocks(), unset (no-op) in production.
let mockAudioDevicesProvider: (() => Record<string, string>) | undefined;

export function setMockAudioDevicesProvider(
	provider: (() => Record<string, string>) | undefined,
): void {
	mockAudioDevicesProvider = provider;
}

export function getAudioDevices() {
	const mock = mockAudioDevicesProvider?.();
	if (mock && Object.keys(mock).length > 0) {
		return { ...mock, ...audioDevices };
	}
	return audioDevices;
}

// Warn-only (NEVER mutate): a real device may hotplug the named asrc later
// (see `asrcProbe`), so the operator's selection is preserved verbatim.
export function warnIfConfiguredAudioSourceUnavailable(
	asrc: string | undefined,
): void {
	if (!asrc) return;
	// The "Auto" sentinel is not a device — it resolves at start (auto-audio.ts).
	if (asrc === AUDIO_SOURCE_AUTO) return;
	const devices = getAudioDevices();
	if (asrc in devices) return;
	logger.warn(
		`Configured audio source '${asrc}' is not in the current device list; leaving config.asrc unchanged (a real device may hotplug it later).`,
		{ asrc, available: Object.keys(devices) },
	);
}

// `id` MUST equal the device-map key (the asrc wire string) so it stays byte-equal
// to the matching `asrcs` entry and `config.asrc` semantics are unchanged. Only the
// two pseudo-sources carry a `labelKey`; hardware device names are never translated.
export function deriveAudioSources(
	devices: Record<string, string> = getAudioDevices(),
	labels?: Map<string, string>,
	identities?: Map<string, AudioDeviceIdentity>,
): AudioSource[] {
	return Object.keys(devices).map((name): AudioSource => {
		if (name === NO_AUDIO_ID) {
			return { id: name, kind: "none", labelKey: "audio.sources.noAudio" };
		}
		if (name === DEFAULT_AUDIO_ID) {
			return {
				id: name,
				kind: "pipeline_default",
				labelKey: "audio.sources.pipelineDefault",
			};
		}
		const label = labels?.get(name);
		const identity = identities?.get(name);
		return {
			id: name,
			kind: "device",
			...(label !== undefined ? { label } : {}),
			...(identity?.product_name !== undefined
				? { product_name: identity.product_name }
				: {}),
			...(identity?.transport !== undefined
				? { transport: identity.transport }
				: {}),
			...(identity?.stable_id !== undefined
				? { stable_id: identity.stable_id }
				: {}),
		};
	});
}

function getAudioSrcName(id: string) {
	const name = getAudioSrcAliases()[id];
	if (name) return name;
	return id;
}

export function getAudioSrcId(name: string) {
	return getAudioSrcReverseAliases()[name] ?? name;
}

function addAudioCardById(list: Record<string, string>, id: string) {
	const name = getAudioSrcName(id);
	list[name] = id;
}

// The `/proc/asound/cards` read is isRealDevice()-gated and degrades to an empty
// longname map — `readTextFile` swallows read errors and `parseAsoundCards` never
// throws, so a garbled/absent/unreadable file never breaks the audio broadcast.
async function resolveAudioLabelsForTick(
	devices: Record<string, string>,
): Promise<Map<string, string>> {
	let longnames = new Map<string, string>();
	if (await isRealDevice()) {
		const text = await readTextFile(PROC_ASOUND_CARDS);
		if (text !== undefined) longnames = parseAsoundCards(text);
	}
	return resolveAudioLabels(devices, getEngineAudioDevices(), longnames);
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

	let devices: string[];
	try {
		devices = await readdirP(dir);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
		devices = [];
	}
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

	// Lifecycle indicator: the selected audio device vanishing mid-stream keeps
	// the stream running in SILENCE (Todo 17 failover — never a test tone); raise
	// a persistent notification so the operator knows the audio dropped.
	reportActiveAudioSource({
		isStreaming: getStreamingProcesses().length > 0,
		isDeviceLost: isSelectedAudioLost(
			getConfig().asrc,
			Object.keys(audioDevices),
		),
	});

	const labels = await resolveAudioLabelsForTick(audioDevices);
	const identities = resolveAudioIdentities(
		audioDevices,
		getEngineAudioDevices(),
	);
	broadcastMsg("status", {
		asrcs: Object.keys(audioDevices),
		audio_sources: deriveAudioSources(audioDevices, labels, identities),
	});

	// A re-enumeration may change what "Auto" resolves to; refresh the idle
	// preview (a no-op while streaming — the live value stays frozen).
	refreshResolvedAsrcPreview();

	// A hotplug re-enumeration may have brought in the device a stream start is
	// waiting on — wake the pending probe so it re-checks now instead of after
	// the next poll tick, beating the QW-J timeout (QW-E ↔ QW-J interaction).
	asrcProbeWake?.();
}

let asrcProbeReject: (() => void) | undefined;
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

		void poll();
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
