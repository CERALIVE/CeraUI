/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

/* Log download */
export function downloadLog(msg: { name: string; contents: string }) {
	const blob = new Blob([msg.contents], { type: "text/plain" });

	const a = window.document.createElement("a");
	a.href = window.URL.createObjectURL(blob);
	a.download = msg.name;
	a.click();

	window.URL.revokeObjectURL(blob.toString());
}
