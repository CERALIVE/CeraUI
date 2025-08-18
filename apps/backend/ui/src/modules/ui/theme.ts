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

function getThemeSetting() {
	return String($("#themeSelector>select").val());
}

function updateTheme(theme_?: string) {
	let theme = theme_ || getThemeSetting();

	if (theme === "auto") {
		if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
			theme = "dark";
		}
	}

	if (theme === "dark") {
		$("body").addClass("dark");
	} else {
		$("body").removeClass("dark");
	}
}

// Load the persistent setting, if available
function loadThemeSetting() {
	const s = localStorage.getItem("theme");
	if (s) {
		$("#themeSelector>select").val(s);
	}
	updateTheme();
}

export function initTheme() {
	loadThemeSetting();

	// Update the theme if the selector is changed
	$("#themeSelector>select").on("change", () => {
		const s = getThemeSetting();
		localStorage.setItem("theme", s);
		updateTheme(s);
	});

	// Update the theme if the system preference changes
	if (window.matchMedia) {
		window
			.matchMedia("(prefers-color-scheme: dark)")
			.addEventListener("change", () => {
				updateTheme();
			});
	}
}
