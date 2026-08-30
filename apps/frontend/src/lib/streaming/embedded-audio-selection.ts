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

// A SOURCE THAT BRINGS ITS OWN AUDIO HAS NO DEVICE TO PICK.
//
// An RTMP/SRT network-ingest source carries its audio muxed into the incoming
// stream ("Includes audio" on the row). Selecting one used to write `config.source`
// and nothing else, so a device-based `config.asrc` chosen for the previous camera
// stayed on disk and on screen — the picker went on offering "DJI Mic Mini" for a
// stream whose audio does not come from a card at all, and that stale pick is what
// a later start would resolve.
//
// Switching BACK deliberately restores NOTHING. An earlier revision remembered the
// displaced pick and re-applied it on return; that is the same "remembers the last
// device audio selection" the report asked to remove, and on a board it never fired
// anyway. "Auto" is the honest landing state — it re-resolves to the returned-to
// source's own device — so there is no session memory here and nothing to go stale.

import type { StreamSource } from "@ceraui/rpc/schemas";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";

const AUDIO_SOURCE_NO_AUDIO = "No audio";
const AUDIO_SOURCE_PIPELINE_DEFAULT = "Pipeline default";

/** Does this pick name a real capture device, rather than a pipeline sentinel? */
export function isDeviceAudioPick(asrc: string | undefined): boolean {
	if (asrc === undefined || asrc === "") return false;
	return (
		asrc !== AUDIO_SOURCE_AUTO &&
		asrc !== AUDIO_SOURCE_NO_AUDIO &&
		asrc !== AUDIO_SOURCE_PIPELINE_DEFAULT
	);
}

/**
 * Does the source carry its own audio, leaving nothing for the device picker to
 * choose?
 *
 * Keyed on the source's declared `audioKind`, never on `origin === 'network'`: it
 * is the AUDIO property that matters, and a network source whose engine reports
 * `selectable` still wants a device.
 */
export function carriesEmbeddedAudio(source: StreamSource): boolean {
	return source.audioKind === "embedded";
}

export interface AudioSelectionPlan {
	/** The `asrc` to write alongside the source, or `undefined` to leave it be. */
	readonly asrc?: string;
}

/**
 * What should happen to the audio selection when the operator picks `next`.
 *
 * Deliberately does NOTHING in every case it cannot improve — a source that still
 * wants a device, and an operator who already chose "No audio" for an ingest row.
 * A selection the operator made themselves is never overwritten to tidy it up.
 */
export function planAudioSelectionForSource(
	next: StreamSource,
	currentAsrc: string | undefined,
): AudioSelectionPlan {
	if (!carriesEmbeddedAudio(next)) return {};
	if (!isDeviceAudioPick(currentAsrc)) return {};
	return { asrc: AUDIO_SOURCE_AUTO };
}
