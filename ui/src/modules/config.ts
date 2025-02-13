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

import { initDelaySlider } from "./audio-delay.ts";
import { updateAudioSrcs } from "./audio-sources.ts";
import { initBitrateSlider } from "./bitrate.ts";
import { updatePipelines } from "./pipelines.ts";
import { updateRelays } from "./remote-relays.ts";
import { initSrtLatencySlider } from "./srt-latency.ts";
import { showHideRelayHint } from "./srtla-address.ts";
import { getSshStatus, showSshStatus } from "./ssh.ts";

export type Config = {
	max_br?: number;
	delay?: number;
	srt_latency?: number;
	srtla_addr?: string;
	srtla_port?: string;
	srt_streamid?: string;
	remote_key?: string;
	bitrate_overlay?: boolean;
	ssh_pass?: string;
	asrc?: string;
	acodec?: string;
	relay_server?: string;
	relay_account?: string;
	pipeline?: string;
};

export let config: Config = {};

/* Configuration loading */
export function loadConfig(c: Config) {
	config = c;

	initBitrateSlider(config.max_br ?? 5000);
	initDelaySlider(config.delay ?? 0);
	initSrtLatencySlider(config.srt_latency ?? 2000);
	updatePipelines(null);
	updateAudioSrcs(null);
	updateRelays(null);

	const srtlaAddr = config.srtla_addr ?? "";
	showHideRelayHint(srtlaAddr);
	$("#srtlaAddr").val(srtlaAddr);
	$("#srtlaPort").val(config.srtla_port ?? "");
	$("#srtStreamid").val(config.srt_streamid ?? "");

	$("#remoteDeviceKey").val(config.remote_key ?? "");
	$("#remoteKeyForm button[type=submit]").prop("disabled", true);
	$("#bitrateOverlay").prop("checked", config.bitrate_overlay);

	if (config.ssh_pass && getSshStatus()) {
		showSshStatus();
	}
}
