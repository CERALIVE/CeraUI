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

// `preview_encoder_realized` status source — what the LIVE session's PREVIEW
// branch is actually encoding with (cerastream 2026.7.6).
//
// This is the SESSION half of the preview capability triple. The other half —
// whether the board publishes a hardware preview encoder at all — rides the
// capabilities fetch (`preview.preview_hw_capability`), which is readable while
// idle. Neither substitutes for the other: a capable board can be realizing
// software, and a live software realization says nothing about capability.
//
// It mirrors `engine-bitrate-status.ts` exactly: a registered mock provider
// short-circuits the real read in dev/e2e (a non-null return wins), production
// reads engine telemetry through the frozen `getStreamingBackend()` seam, and a
// null return means "no preview branch, or the engine predates the field" —
// never a fabricated "software".

import type { PreviewEncoderRealized } from "@ceraui/rpc/schemas";
import { getStreamingBackend } from "./streaming-engine.ts";

type MockPreviewEncoderRealizedProvider = () => PreviewEncoderRealized | null;

let mockPreviewEncoderRealizedProvider: MockPreviewEncoderRealizedProvider | null =
	null;

/** Register (or clear with null) the dev/e2e mock realized-preview provider. */
export function setMockPreviewEncoderRealizedProvider(
	fn: MockPreviewEncoderRealizedProvider | null,
): void {
	mockPreviewEncoderRealizedProvider = fn;
}

/** The engine telemetry shape written by `CerastreamBackend.handleEvent`. */
type PreviewEncoderTelemetry = {
	preview_encoder_realized?: PreviewEncoderRealized;
};

/**
 * The live preview encoder reading for a status snapshot: the mock provider's
 * value in dev/e2e, else the real engine telemetry. Null when there is no live
 * session, the session has no preview branch, or the engine predates the field.
 */
export function getPreviewEncoderRealizedStatus(): PreviewEncoderRealized | null {
	const mock = mockPreviewEncoderRealizedProvider?.();
	if (mock) return mock;
	const telemetry = getStreamingBackend().getTelemetry?.() as
		| PreviewEncoderTelemetry
		| null
		| undefined;
	return telemetry?.preview_encoder_realized ?? null;
}
