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

import { exec } from "node:child_process";

import type WebSocket from "ws";

import { notificationSend } from "./notifications.ts";
import { buildMsg, getSocketSenderId } from "./websocket-server.ts";

export function getLog(conn: WebSocket, service?: string) {
	const senderId = getSocketSenderId(conn);
	let cmd = "journalctl -b";
	let name = "belabox_system_log.txt";

	if (service) {
		cmd += ` -u ${service}`;
		name = `${service.replace("belaUI", "belabox")}_log.txt`;
	}

	exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
		if (err) {
			const msg = `Failed to fetch the log: ${err}`;
			notificationSend(conn, "log_error", "error", msg, 10);
			console.log(msg);
			return;
		}

		conn.send(buildMsg("log", { name, contents: stdout }, senderId));
	});
}
