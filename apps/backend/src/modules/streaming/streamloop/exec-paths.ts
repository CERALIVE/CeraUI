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

// Resolved executable paths for the supervised stream subprocesses. Kept in a
// dependency-light module (no streaming logic) so other modules — bcrpt.ts,
// system/revisions.ts — can read them without pulling in the spawn/orchestration
// graph, which also breaks the streamloop<->bcrpt import cycle cleanly.

import { getSrtlaSendExec } from "@ceralive/srtla/sender";
import { setup } from "../../setup.ts";

export const srtlaSendExec = getSrtlaSendExec(setup.srtla_path);
export const bcrptExec = `${setup.bcrpt_path ?? "/usr/bin"}/bcrpt`;
