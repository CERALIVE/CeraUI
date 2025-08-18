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

export function updateSensors(sensors: Record<string, string>) {
	const sensorList = [];

	for (const i in sensors) {
		const data = sensors[i];
		const entryHtml = `
		  <tr>
			<td class="sensor_name"></td>
			<td class="sensor_value"></td>
		  </tr>`;
		const entry = $($.parseHTML(entryHtml));
		entry.find(".sensor_name").text(i);
		entry.find(".sensor_value").text(data);
		sensorList.push(entry);
	}

	$("#sensors").html(sensorList as unknown as string);
}
