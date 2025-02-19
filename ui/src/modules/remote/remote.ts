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

import { config } from "../config.ts";
import { ws } from "../ui/websocket.ts";

export type RemoteStatus = true | { error: string };

/* Remote status */
let remoteConnectedHideTimer: ReturnType<typeof setTimeout> | undefined;

export function showRemoteStatus(status: RemoteStatus) {
	if (remoteConnectedHideTimer) {
		clearTimeout(remoteConnectedHideTimer);
		remoteConnectedHideTimer = undefined;
	}

	if (status === true) {
		$("#remoteStatus").removeClass("alert-danger");
		$("#remoteStatus").addClass("alert-success");
		$("#remoteStatus").text("BELABOX cloud remote: connected");
		remoteConnectedHideTimer = setTimeout(() => {
			$("#remoteStatus").addClass("d-none");
			remoteConnectedHideTimer = undefined;
		}, 5000);
	} else if (status.error) {
		switch (status.error) {
			case "network":
				$("#remoteStatus").text(
					"BELABOX cloud remote: network error. Trying to reconnect...\n",
				);
				break;
			case "key":
				$("#remoteStatus").text("BELABOX cloud remote: invalid key\n");
				break;
			default:
				return;
		}

		$("#remoteStatus").addClass("alert-danger");
		$("#remoteStatus").removeClass("alert-success");
	} else {
		return;
	}
	$("#remoteStatus").removeClass("d-none");
}

function checkRemoteKey() {
	const remote_key = String($("#remoteDeviceKey").val());
	const disabled = remote_key === config.remote_key;
	$("#remoteKeyForm button[type=submit]").prop("disabled", disabled);
}

export function initRemote() {
	$("#remoteDeviceKey").on("input", checkRemoteKey);

	$("#remoteKeyForm").on("submit", () => {
		const remote_key = $("#remoteDeviceKey").val();
		ws?.send(JSON.stringify({ config: { remote_key } }));
		return false;
	});
}
