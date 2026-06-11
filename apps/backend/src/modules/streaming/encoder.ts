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

// Pure bitrate validation helpers. The streaming-time bitrate setter (which
// persists config + hot-reloads the engine) now lives behind the StreamingBackend
// seam as `ceracoderBackend.setBitrate` (ceracoder-backend.ts); these clamp/
// validate helpers stay engine-agnostic and side-effect free.

import type { BitrateParams } from "./streaming-backend.ts";

export type { BitrateParams };

const MIN_BITRATE = 300; // Kbps
const MAX_BITRATE = 12_000; // Kbps

// Snaps into the hardware window instead of rejecting (cf. validateBitrate),
// so setters can report the post-clamp value they actually wrote.
export function clampBitrate(maxBr: number): number {
	if (maxBr < MIN_BITRATE) return MIN_BITRATE;
	if (maxBr > MAX_BITRATE) return MAX_BITRATE;
	return maxBr;
}

export function validateBitrate(params: BitrateParams): number | undefined {
	const maxBr = params.max_br;
	if (typeof maxBr !== "number" || Number.isNaN(maxBr)) return;
	if (maxBr < MIN_BITRATE || maxBr > MAX_BITRATE) return;
	return maxBr;
}
