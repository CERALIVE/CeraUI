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

/* Audio device / codec selection */
import { config } from "../config.ts";

let audioSrcList: Array<string> = [];
export function updateAudioSrcs(list: Array<string> | null = null) {
	if (list !== null) {
		audioSrcList = list;
	}

	const audioSelect = document.getElementById("audioSource");
	if (!audioSelect) return;

	audioSelect.innerText = "";
	let asrcFound = false;

	for (const card of audioSrcList) {
		const option = document.createElement("option");
		option.value = card;
		option.innerText = card;

		audioSelect.append(option);
		if (config.asrc && card === config.asrc) {
			option.selected = true;
			asrcFound = true;
		}
	}

	if (config.asrc && !asrcFound) {
		const option = document.createElement("option");
		option.innerText = `${config.asrc} (unavailable)`;
		option.value = config.asrc;
		option.selected = true;
		audioSelect.append(option);
	}
}
