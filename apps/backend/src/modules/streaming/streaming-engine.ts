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

// Engine registry behind the StreamingBackend seam. The `engine` flag in
// setup.json picks which implementation every streaming call site drives — no
// code change to switch engines. Resolution is LAZY + memoized: the backends sit
// in a streamloop import cycle, so reading the singletons at module-eval would
// hit a TDZ ReferenceError (see ceracoder.ts). `getStreamingBackend()` defers the
// lookup to first call (always post-init); `resolveStreamingBackend` is the pure
// selector the tests boot in both modes.

import type { StreamingEngine } from "../../helpers/config-schemas.ts";
import { setup } from "../setup.ts";
import { ceracoderBackend } from "./ceracoder-backend.ts";
import { cerastreamBackend } from "./cerastream-backend.ts";
import type { StreamingBackend } from "./streaming-backend.ts";

export const DEFAULT_STREAMING_ENGINE: StreamingEngine = "cerastream";

/** Pure selector: engine flag -> the matching backend singleton. */
export function resolveStreamingBackend(
	engine: StreamingEngine,
): StreamingBackend {
	return engine === "cerastream" ? cerastreamBackend : ceracoderBackend;
}

/** The configured engine; defaults to cerastream (Task 37, post boot-parity). */
export function getConfiguredEngine(): StreamingEngine {
	return setup.engine ?? DEFAULT_STREAMING_ENGINE;
}

let resolvedBackend: StreamingBackend | undefined;

/** The active backend for the configured engine (memoized on first call). */
export function getStreamingBackend(): StreamingBackend {
	if (!resolvedBackend) {
		resolvedBackend = resolveStreamingBackend(getConfiguredEngine());
	}
	return resolvedBackend;
}
