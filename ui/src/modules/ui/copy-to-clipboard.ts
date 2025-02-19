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

/* Input fields automatically copied to clipboard when clicked */
function copyInputValToClipboard(obj: HTMLElement): boolean {
	if (
		!document.queryCommandSupported ||
		!document.queryCommandSupported("copy")
	) {
		return false;
	}

	const valField = $("<input>");
	valField.css("position", "fixed");
	valField.css("top", "100000px");
	valField.val(String($(obj).val()));
	$("body").append(valField);

	let success = false;
	try {
		valField.select();
		document.execCommand("copy");
		success = true;
	} catch (err) {
		if (err instanceof Error)
			console.log(`Copying failed: ${err.message as string}`);
	}

	valField.remove();

	return success;
}

const timerMap = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function initCopyToClipboard() {
	$("input.click-copy").tooltip({ title: "Copied", trigger: "manual" });
	$("input.click-copy").on("click", (ev) => {
		const target = ev.target;
		const input = $(ev.target);

		if (copyInputValToClipboard(target)) {
			input.tooltip("show");
			if (timerMap.has(target)) {
				clearTimeout(timerMap.get(target));
			}

			timerMap.set(
				target,
				setTimeout(() => {
					input.tooltip("hide");
					timerMap.delete(target);
				}, 3000),
			);
		}
	});
}
