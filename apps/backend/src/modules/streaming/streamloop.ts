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

// Re-export barrel. The streamloop implementation was split into focused modules
// under ./streamloop/ — see ./streamloop/index.ts for the locked public surface.
// This file exists so every existing `from ".../streamloop.ts"` import keeps
// resolving to the same symbols.

export * from "./streamloop/index.ts";

// todo-4 code-gate probe
