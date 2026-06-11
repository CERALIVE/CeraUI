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

// Dependency-light ceracoder path accessors. The engine OPERATIONS (config
// write, SIGHUP reload, run-arg build, bitrate set, spawn/stop, stderr
// classification) all moved behind the StreamingBackend seam in
// `ceracoder-backend.ts`. These two trivial binding reads deliberately stay here,
// reading `@ceralive/ceracoder` directly rather than through the backend
// singleton, so this module pulls in NONE of the spawn/orchestration graph. That
// keeps it a leaf for `pipelines.ts` (TEMP_PIPELINE_PATH) and
// `streamloop/exec-paths.ts` (getCeracoderExec) and avoids an
// engine-driver ⇄ pipelines import cycle (the singleton would otherwise be read
// at module-eval time mid-cycle → temporal-dead-zone ReferenceError).

import {
	CERACODER_PATHS,
	getCeracoderExec as getExecFromBindings,
} from "@ceralive/ceracoder";
import { setup } from "../setup.ts";

export const TEMP_PIPELINE_PATH = CERACODER_PATHS.pipeline;

/**
 * Get the ceracoder executable path.
 * Uses setup.ceracoder_path as override if configured.
 */
export function getCeracoderExec(): string {
	return getExecFromBindings({ execPath: setup.ceracoder_path });
}
