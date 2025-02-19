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

function showDelay(value: number) {
	const element = document.getElementById(
		"delayValue",
	) as HTMLInputElement | null;
	if (!element) return;

	element.value = `Audio delay: ${value} ms`;
}

export function initDelaySlider(defaultDelay: number) {
	$("#delaySlider").slider({
		min: -2000,
		max: 2000,
		step: 20,
		value: defaultDelay,
		slide: (_, ui) => {
			showDelay(ui.value ?? defaultDelay);
		},
	});
	showDelay(defaultDelay);
}
