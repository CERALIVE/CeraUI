/*
    CeraUI - web UI for the CeraLive project
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

/**
 * Whether an audio-backend selection may be ACCEPTED, decided against the
 * engine's own capability payload and nothing else.
 *
 * The honesty rule this enforces: CeraUI may only offer or accept a backend the
 * engine has positively advertised as supported. A device whose engine build
 * carries no PipeWire arm must not be able to persist `pipewire` — a stored
 * selection the engine cannot honour becomes a start failure the operator has no
 * way to undo from the UI.
 *
 * FAIL-CLOSED, which is the deliberate opposite of `device-mode-truth.ts`'s
 * fail-open rule, because the two answer different questions. That rule refuses
 * to BLOCK a save on an unknown; this one refuses to CREATE a selection on one.
 * An absent `audio_backends` block means the engine never stated a capability —
 * a legacy engine, or a snapshot that fell back to the minimal safe set — and
 * inventing support there is exactly the unverifiable claim being prevented.
 * Nothing is lost by refusing: an absent selection is already the working state
 * on every device today, and it is what hands the engine its own default.
 *
 * This never decides what a RUNNING engine does. It gates the CeraUI-side write
 * only; a backend the engine later refuses surfaces the engine's own typed error
 * verbatim, and is never silently reverted to the other arm.
 */

import type { AudioBackend } from "@ceralive/cerastream";

/** Typed `setConfig` refusal for a backend the engine has not advertised. */
export const AUDIO_BACKEND_UNSUPPORTED_ERROR = "audio_backend_unsupported";

/** The engine capability block this gate reads; absent on every fallback rung. */
export interface AudioBackendCapability {
	supported: readonly AudioBackend[];
	active: AudioBackend;
}

export function isAudioBackendSupported(
	backend: AudioBackend,
	capability: AudioBackendCapability | undefined,
): boolean {
	return capability?.supported.includes(backend) ?? false;
}
