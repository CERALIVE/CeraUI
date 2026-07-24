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

// Public surface of the streamloop module. The split is internal only — these
// named re-exports reproduce exactly the symbols the original streamloop.ts
// exposed, so every existing `from ".../streamloop.ts"` import resolves unchanged.

export {
	AUTOSTART_CHECK_FILE,
	autoStartStream,
	checkAutoStartStream,
	setAutostart,
} from "./autostart.ts";
export { srtlaSendExec } from "./exec-paths.ts";
export { start, stop } from "./session.ts";
export { startStream } from "./start-stream.ts";
