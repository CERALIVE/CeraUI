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

import {initSliderLock, setSliderAutolockTimer} from "../ui/sliders-lock.ts";

function showSrtLatency(value: number) {
	const element = document.getElementById(
		"srtLatencyValue",
	) as HTMLInputElement | null;
	if (!element) return;

	element.value = `SRT latency: ${value} ms`;

	if (value < 1500) {
		$("#latencyWarning").removeClass("d-none");
	} else {
		$("#latencyWarning").addClass("d-none");
	}
}

export function initSrtLatencySlider(defaultLatency: number) {
	const s = $("#srtLatencySlider");
	s.slider({
		min: 100,
		max: 4000,
		step: 100,
		value: defaultLatency,
		slide: (_, ui) => {
			showSrtLatency(ui.value ?? defaultLatency);
			setSliderAutolockTimer(s);
		},
	});
	initSliderLock(s);
	showSrtLatency(defaultLatency);
}
