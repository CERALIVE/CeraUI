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

// Engine registry behind the StreamingBackend seam. cerastream is the ONLY
// engine since the legacy engine was retired, so resolution is
// trivial — every streaming call site still goes through `getStreamingBackend()`
// so a future engine can slot in behind the same seam. Legacy `engine` values
// persisted in setup.json are coerced to "cerastream" at schema-parse time
// (helpers/config-schemas.ts).

import type { StreamingEngine } from "../../helpers/config-schemas.ts";
import { setup } from "../setup.ts";
import { cerastreamBackend } from "./cerastream-backend.ts";
import type { StreamingBackend } from "./streaming-backend.ts";

export const DEFAULT_STREAMING_ENGINE: StreamingEngine = "cerastream";

/** Pure selector: engine flag -> the matching backend singleton. */
export function resolveStreamingBackend(
	_engine: StreamingEngine,
): StreamingBackend {
	return cerastreamBackend;
}

/** The configured engine; always "cerastream" (legacy values are coerced). */
export function getConfiguredEngine(): StreamingEngine {
	return setup.engine ?? DEFAULT_STREAMING_ENGINE;
}

/** The active backend every streaming call site drives. */
export function getStreamingBackend(): StreamingBackend {
	return cerastreamBackend;
}
