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

import type { StatusResponseMessage } from "@belaui/server/modules/ui/status.ts";

/* Software updates */
import { sendCommand } from "../ui/websocket.ts";

export function showSoftwareUpdates(
	status: StatusResponseMessage["available_updates"],
) {
	if (status) {
		if (status.package_count) {
			$("#softwareUpdate span.desc").text(
				`(${status.package_count} packages, ${status.download_size})`,
			);
		} else {
			$("#softwareUpdate span.desc").text("(up to date)");
		}
		$("#softwareUpdate").prop("disabled", !status.package_count);
	} else if (status === null) {
		$("#softwareUpdate span.desc").text("(checking for updates...)");
		$("#softwareUpdate").prop("disabled", true);
	}
	if (status === false) {
		$("#softwareUpdate").addClass("d-none");
	} else {
		$("#softwareUpdate").removeClass("d-none");
	}
}

function showSoftwareUpdateValue(cls: string, value: number, total: number) {
	if (value > 0) {
		$(`#softwareUpdateStatus .${cls} .value`).text(`${value} / ${total}`);
		$(`#softwareUpdateStatus .${cls}`).removeClass("d-none");
	} else {
		$(`#softwareUpdateStatus .${cls}`).addClass("d-none");
	}
}

export function showSoftwareUpdateStatus(
	status: StatusResponseMessage["updating"],
) {
	if (!status) {
		$("#softwareUpdateStatus").addClass("d-none");
		return;
	}

	$("#startStop, #softwareUpdate, .command-btn").prop(
		"disabled",
		status.result === undefined,
	);

	showSoftwareUpdateValue("downloading", status.downloading, status.total);
	showSoftwareUpdateValue("unpacking", status.unpacking, status.total);
	showSoftwareUpdateValue("setting-up", status.setting_up, status.total);

	if (status.result === 0) {
		$("#softwareUpdateStatus p.result").text(
			"Update completed. Restarting the encoder...",
		);
		$("#softwareUpdateStatus p.result").removeClass("text-danger");
		$("#softwareUpdateStatus p.result").addClass("text-success");
		$("#softwareUpdateStatus .result").removeClass("d-none");
	} else if (status.result !== undefined) {
		$("#softwareUpdateStatus p.result").text(`Update error: ${status.result}`);
		$("#softwareUpdateStatus p.result").removeClass("text-success");
		$("#softwareUpdateStatus p.result").addClass("text-danger");
		$("#softwareUpdateStatus .result").removeClass("d-none");
	} else {
		$("#softwareUpdateStatus .result").addClass("d-none");
	}

	$("#softwareUpdateStatus").removeClass("d-none");
}

export function initSoftwareUpdate() {
	$("#softwareUpdate").on("click", () => {
		const msg =
			"Are you sure you want to start a software update? " +
			"This may take several minutes. " +
			"You won't be able to start a stream until it's completed. " +
			"The encoder will briefly disconnect after a successful upgrade. " +
			"Never remove power or reset the encoder while updating. If the encoder is powered from a battery, ensure it's fully charged.";

		if (confirm(msg)) {
			sendCommand("update");
		}
	});
}
