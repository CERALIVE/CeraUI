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

// Per-hardware video-source metadata + audio codec catalog. CeraUI owns this
// data: it drives the pipeline registry (pipelines.ts), config validation
// (streaming.ts) and the UI pipeline lists. The cerastream engine builds its
// GStreamer pipelines internally from the source id alone, so only the
// METADATA (descriptions, defaults, capability flags) lives here — there is no
// pipeline-string builder on the CeraUI side.
//
// The tables were carried over verbatim from the retired legacy engine bindings'
// PipelineBuilder source lists so existing persisted `pipeline` ids and the
// frontend labels keep resolving unchanged.

import type { Framerate, Resolution } from "../../helpers/config-schemas.ts";

export type { Framerate, Resolution };

/** All video source ids across all hardware platforms. */
export type VideoSource =
	| "camlink" // Elgato Cam Link 4K (uncompressed YUY2)
	| "libuvch264" // UVC H264 camera (hardware compressed)
	| "hdmi" // HDMI capture
	| "usb_mjpeg" // USB MJPEG capture card
	| "v4l_mjpeg" // V4L2 MJPEG capture
	| "rtmp" // RTMP ingest
	| "srt" // SRT ingest
	| "test" // Test pattern
	| "decklink"; // Blackmagic Decklink SDI

/** Hardware platforms with a source table (superset of setup.json `hw`). */
export type PipelineHardwareType = "jetson" | "n100" | "rk3588" | "generic";

/** Audio codec catalog used for config validation + the `acodecs` broadcast. */
export const AUDIO_CODECS: Record<string, { name: string }> = {
	aac: { name: "AAC" },
	opus: { name: "Opus" },
};


