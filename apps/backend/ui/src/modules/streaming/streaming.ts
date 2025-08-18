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

import type { Config } from "../config.ts";
import { getIsValidRelaySelection } from "../remote/remote-relays.ts";
import { hideError } from "../ui/error-message.ts";
import { ws } from "../ui/websocket.ts";
import { getPipelines } from "./pipelines.ts";

let isStreaming = false;

export function setIsStreaming(status: boolean) {
	isStreaming = status;
}

export function getIsStreaming() {
	return isStreaming;
}

/* Start / stop */
function getConfig() {
	const maxBr = $("#bitrateSlider").slider("value");

	const config: Config = {};
	config.pipeline = (
		document.getElementById("pipelines") as HTMLInputElement
	).value;

	const pipelines = getPipelines();
	if (pipelines[config.pipeline].asrc) {
		config.asrc = (
			document.getElementById("audioSource") as HTMLInputElement
		).value;
	}
	if (pipelines[config.pipeline].acodec) {
		config.acodec = (
			document.getElementById("audioCodec") as HTMLInputElement
		).value;
	}
	config.delay = $("#delaySlider").slider("value");
	config.max_br = maxBr;
	config.srt_latency = $("#srtLatencySlider").slider("value");
	config.bitrate_overlay = $("#bitrateOverlay").prop("checked");

	const relayServer = String($("#relayServer").val());
	if (relayServer !== "manual") {
		config.relay_server = relayServer;
	} else {
		config.srtla_addr = String($("#srtlaAddr").val());
		config.srtla_port = String($("#srtlaPort").val());
	}

	const relayAccount = String($("#relayAccount").val());
	if (relayServer !== "manual" && relayAccount !== "manual") {
		config.relay_account = relayAccount;
	} else {
		config.srt_streamid = String($("#srtStreamid").val());
	}

	return config;
}

async function start() {
	hideError();

	ws?.send(JSON.stringify({ start: getConfig() }));
}

async function stop() {
	ws?.send(JSON.stringify({ stop: 0 }));
}

/* UI */
let startStopButtonIsEnabled: boolean | undefined;

export function updateButtonEnabledDisabled(isEnabled?: boolean) {
	if (isEnabled !== undefined) {
		startStopButtonIsEnabled = isEnabled;
	}
	const button = $("#startStop");
	button.prop(
		"disabled",
		!startStopButtonIsEnabled || !getIsValidRelaySelection(),
	);
}

export function updateButton({
	add,
	remove,
	text,
	enabled,
}: {
	add?: string;
	remove?: string;
	text: string;
	enabled: boolean;
}) {
	const button = document.getElementById("startStop");
	if (!button) return;

	if (add) button.classList.add(add);
	if (remove) button.classList.remove(remove);

	button.innerHTML = text;
	updateButtonEnabledDisabled(enabled);
}

export function initStreamingUi() {
	/* UI event handlers */
	const button = document.getElementById("startStop");
	if (!button) return;

	button.addEventListener("click", () => {
		if (!getIsStreaming()) {
			updateButton({ text: "Starting...", enabled: false });
			start();
		} else {
			updateButton({ text: "Stopping...", enabled: false });
			stop();
		}
	});
}
