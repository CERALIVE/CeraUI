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

import fs from "node:fs";

import killall from "../../helpers/killall.ts";
import { getConfig, saveConfig } from "../config.ts";
import { setup } from "../setup.ts";

const MIN_BITRATE = 300; // Kbps
const MAX_BITRATE = 12_000; // Kbps

export type BitrateParams = { max_br?: number };

export function setBitrate(params: BitrateParams) {
	const minBr = MIN_BITRATE; // Kbps

	if (params.max_br === undefined) return null;
	if (params.max_br < minBr || params.max_br > MAX_BITRATE) return null;

	const config = getConfig();
	config.max_br = params.max_br;
	saveConfig();

	fs.writeFileSync(
		setup.bitrate_file,
		`${minBr * 1000}\n${config.max_br * 1000}\n`,
	);

	killall(["-HUP", "belacoder"]);

	return config.max_br;
}
