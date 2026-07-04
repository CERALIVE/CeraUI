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

// Embedded network-ingest audio gate (Task 13). A network-ingest pipeline
// (rtmp/srt, `audio_kind: 'embedded'`) carries the publisher's audio muxed into
// the incoming stream. The engine can only ROUTE that embedded audio when it
// advertises the `network_embedded_audio` capability (cerastream Task 21). Only
// when BOTH hold does CeraUI skip the ALSA `asrcProbe` and omit `audio.device`
// from the start assembly, letting the engine route embedded audio. Absent the
// capability the legacy selectable-ALSA path is preserved byte-for-byte.

import type { PipelineAudioKind } from "@ceraui/rpc/schemas";

import { getLastCapabilities } from "./capabilities.ts";
import { searchPipelines } from "./pipelines.ts";

export function embeddedAudioActive(
	audioKind: PipelineAudioKind | undefined,
	networkEmbeddedAudio: boolean | undefined,
): boolean {
	return audioKind === "embedded" && networkEmbeddedAudio === true;
}

export function isEmbeddedAudioPipeline(
	pipelineId: string | undefined,
): boolean {
	if (!pipelineId) return false;
	return embeddedAudioActive(
		searchPipelines(pipelineId)?.audio_kind,
		getLastCapabilities()?.network_embedded_audio,
	);
}
