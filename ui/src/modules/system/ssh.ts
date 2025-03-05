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

/* SSH status / control */
import { config } from "../config.ts";
import { sendCommand } from "../ui/websocket.ts";

let sshStatus: StatusResponseMessage["ssh"] | undefined;

export function getSshStatus() {
	return sshStatus;
}

export function setSshStatus(s: StatusResponseMessage["ssh"]) {
	sshStatus = s;
}

export function showSshStatus() {
	if (!sshStatus) return;

	const pass = !config.ssh_pass
		? "password not set"
		: sshStatus.user_pass
			? "user-set password"
			: config.ssh_pass;
	$("label[for=sshPassword]").text(
		`SSH password (username: ${sshStatus.user})`,
	);

	$("#sshPassword").val(pass);
	if (sshStatus.active) {
		$("#startSsh").addClass("d-none");
		$("#stopSsh").removeClass("d-none");
	} else {
		$("#stopSsh").addClass("d-none");
		$("#startSsh").removeClass("d-none");
	}
	$("#sshSettings").removeClass("d-none");
}

export function initSsh() {
	$("#resetSshPass").on("click", () => {
		const msg = "Are you sure you want to reset the SSH password?";

		if (confirm(msg)) {
			sendCommand("reset_ssh_pass");
		}
	});
}
