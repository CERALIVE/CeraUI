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

/* SSH control */
import { exec, spawnSync } from "node:child_process";
import crypto from "node:crypto";

import type WebSocket from "ws";

import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import { setup } from "../setup.ts";
import { notificationSend } from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

type SshStatus = {
	user?: string;
	active?: boolean;
	user_pass?: boolean;
};

let sshStatus: SshStatus | null = null;
let sshPasswordHash: string | undefined;

export function setSshPasswordHash(hash: string | undefined) {
	sshPasswordHash = hash;
}

export function getSshPasswordHash() {
	return sshPasswordHash;
}

function handleSshStatus(s: SshStatus) {
	if (s.user !== undefined && s.active !== undefined && s.user_pass !== undefined) {
		if (
			!sshStatus ||
			s.user !== sshStatus.user ||
			s.active !== sshStatus.active ||
			s.user_pass !== sshStatus.user_pass
		) {
			sshStatus = s;
			broadcastMsg("status", { ssh: sshStatus });
		}
	}
}

function getSshUserHash(callback: (hash: string) => void) {
	if (!setup.ssh_user) return;

	const cmd = `grep "^${setup.ssh_user}:" /etc/shadow`;
	exec(cmd, (err, stdout) => {
		if (err === null && stdout.length) {
			callback(stdout);
		} else {
			logger.error(`Error getting the password hash for ${setup.ssh_user}: ${err}`);
		}
	});
}

export function getSshStatus() {
	if (!setup.ssh_user) return undefined;

	const s: SshStatus = {
		user: setup.ssh_user,
		active: undefined,
	};

	// Check is the SSH server is running
	exec("systemctl is-active ssh", (err, stdout) => {
		if (err === null) {
			s.active = true;
		} else {
			if (stdout === "inactive\n") {
				s.active = false;
			} else {
				logger.error(`Error running systemctl is-active ssh: ${err.message}`);
				return;
			}
		}

		handleSshStatus(s);
	});

	// Check if the user's password has been changed
	getSshUserHash((hash: string) => {
		s.user_pass = hash !== sshPasswordHash;
		handleSshStatus(s);
	});

	// If an immediate result is expected, send the cached status
	return sshStatus;
}

export function startStopSsh(conn: WebSocket, cmd: "start_ssh" | "stop_ssh") {
	if (!setup.ssh_user) return;

	const action = cmd === "start_ssh" ? "start" : "stop";
	if (action === "start" && getConfig().ssh_pass === undefined) {
		resetSshPassword(conn);
	}

	spawnSync("systemctl", [action, "ssh"]);
	getSshStatus();
}

export function resetSshPassword(conn: WebSocket) {
	if (!setup.ssh_user) return;

	const password = crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, "").substring(0, 20);
	const cmd = `printf "${password}\n${password}" | passwd ${setup.ssh_user}`;
	exec(cmd, (err) => {
		if (err) {
			notificationSend(
				conn,
				"ssh_pass_reset",
				"error",
				`Failed to reset the SSH password for ${setup.ssh_user}`,
				10,
			);
			return;
		}
		getSshUserHash((hash: string) => {
			const config = getConfig();
			config.ssh_pass = password;
			sshPasswordHash = hash;
			saveConfig();
			broadcastMsg("config", config);
			getSshStatus();
		});
	});
}
