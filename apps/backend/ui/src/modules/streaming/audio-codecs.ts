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

import { config } from "../config.ts";

let audioCodecList: Record<string, string> = {};

export function audioCodecs(list: Record<string, string> | null = null) {
	if (list !== null) {
		audioCodecList = list;
	}

	const audioCodec = document.getElementById("audioCodec");
	if (!audioCodec) return;

	audioCodec.innerText = "";

	for (const codec in audioCodecList) {
		const option = document.createElement("option");
		option.value = codec;
		option.innerText = audioCodecList[codec];

		if (config.acodec && codec === config.acodec) {
			option.selected = true;
		}
		audioCodec.append(option);
	}
}
