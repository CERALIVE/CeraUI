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

import { ws } from "../ui/websocket.ts";
import { getIsStreaming } from "./streaming.ts";

/* Bitrate setting updates */
type Bitrate = {
	max_br: number;
};

export function updateBitrate(br: Bitrate) {
	$("#bitrateSlider").slider("option", "value", br.max_br);
	showBitrate(br.max_br);
}

function setBitrate(max: number) {
	if (getIsStreaming()) {
		ws?.send(JSON.stringify({ bitrate: { max_br: max } }));
	}
}

function showBitrate(value: number) {
	const element = document.getElementById(
		"bitrateValues",
	) as HTMLInputElement | null;
	if (!element) return;

	element.value = `Max bitrate: ${value} Kbps`;
}

export function initBitrateSlider(bitrateDefault: number) {
	$("#bitrateSlider").slider({
		range: false,
		min: 500,
		max: 12000,
		step: 250,
		value: bitrateDefault,
		slide: (_, ui) => {
			const value = ui.value ?? bitrateDefault;
			showBitrate(value);
			setBitrate(value);
		},
	});
	showBitrate(bitrateDefault);
}
