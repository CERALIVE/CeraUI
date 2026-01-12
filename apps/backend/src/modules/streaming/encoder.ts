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

import { getConfig, saveConfig } from "../config.ts";
import {
	sendCeracoderHup,
	writeCeracoderConfigFile,
} from "./ceracoder.ts";

const MIN_BITRATE = 300; // Kbps
const MAX_BITRATE = 12_000; // Kbps

export type BitrateParams = { max_br?: number };

export function validateBitrate(params: BitrateParams): number | undefined {
	const maxBr = params.max_br;
	if (typeof maxBr !== "number" || Number.isNaN(maxBr)) return;
	if (maxBr < MIN_BITRATE || maxBr > MAX_BITRATE) return;
	return maxBr;
}

export function setBitrate(params: BitrateParams): number | undefined {
	const maxBr = validateBitrate(params);
	if (maxBr === undefined) return;

	const config = getConfig();
	const previousBitrate = config.max_br;

	try {
		config.max_br = maxBr;
		saveConfig();
		writeCeracoderConfigFile(config);
		sendCeracoderHup();
		return maxBr;
	} catch (error) {
		// Restore previous bitrate if operation failed
		config.max_br = previousBitrate;
		console.error("Failed to set bitrate:", error);
		throw error;
	}
}
