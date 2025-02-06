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

import { spawnSync } from "node:child_process";

import type WebSocket from "ws";
import { WebSocketServer } from "ws";

import { getms } from "../helpers/time.ts";
import { extractMessage } from "../helpers/types.ts";

import { logger } from "../helpers/logger.ts";
import {
	type AuthMessage,
	getPasswordHash,
	handleLogout,
	isAuthedSocket,
	setPassword,
	stripPasswords,
	tryAuth,
} from "./auth.ts";
import { type BitrateParams, setBitrate } from "./encoder.ts";
import { httpServer } from "./http-server.ts";
import { getLog } from "./logs.ts";
import { type ModemsMessage, handleModems } from "./modems.ts";
import {
	type NetworkInterfaceMessage,
	handleNetif,
} from "./network-interfaces.ts";
import { notificationSendPersistent } from "./notifications.ts";
import { getRemoteWebSocket, setRemoteKey } from "./remote.ts";
import { isUpdating, startSoftwareUpdate } from "./software-updates.ts";
import { resetSshPassword, startStopSsh } from "./ssh.ts";
import { sendStatus } from "./status.ts";
import { type StartMessage, getIsStreaming } from "./streaming.ts";
import { start, stop } from "./streamloop.ts";
import { type WifiMessage, handleWifi } from "./wifi.ts";

type KeepAliveMessage = { keepalive: unknown };
type StopMessage = { stop: unknown };
type BitrateMessage = { bitrate: BitrateParams };

type ConfigPasswordMessage = {
	password: string;
};

type ConfigRemoteKeyMessage = {
	remote_key: string;
};

type ConfigMessage = {
	config: ConfigPasswordMessage | ConfigRemoteKeyMessage;
};

type CommandMessage = {
	command: string;
};

export type Message =
	| KeepAliveMessage
	| StartMessage
	| StopMessage
	| BitrateMessage
	| AuthMessage
	| ConfigMessage
	| CommandMessage
	| WifiMessage
	| ModemsMessage
	| NetworkInterfaceMessage;

const lastActiveSocket = new WeakMap<WebSocket, number>();
const socketSenderIds = new WeakMap<WebSocket, string>();

let wss: WebSocketServer;

export function initWebSocketServer() {
	wss = new WebSocketServer({ server: httpServer });
	wss.on("connection", function connection(conn) {
		markConnectionActive(conn);

		if (!getPasswordHash()) {
			conn.send(buildMsg("status", { set_password: true }));
		}
		notificationSendPersistent(conn, false);

		conn.on("message", function incoming(msg) {
			try {
				const parsedMessage = JSON.parse(msg.toString()) as Message;
				handleMessage(conn, parsedMessage);
			} catch (err) {
				if (err instanceof Error) {
					logger.error(`Error parsing client message: ${err.message}`);
				}
			}
		});
	});
}

export function handleMessage(conn: WebSocket, msg: Message, isRemote = false) {
	// log all received messages except for keepalives
	if (Object.keys(msg).length > 1 || !("keepalive" in msg)) {
		logger.debug(stripPasswords(msg));
	}

	if (!isRemote) {
		for (const type in msg) {
			switch (type) {
				case "auth":
					tryAuth(conn, extractMessage<AuthMessage, typeof type>(msg, type));
					break;
			}
		}
	}

	for (const type in msg) {
		switch (type) {
			case "config":
				handleConfig(
					conn,
					extractMessage<ConfigMessage, typeof type>(msg, type),
					isRemote,
				);
				break;
		}
	}

	if (!isAuthedSocket(conn)) return;

	for (const type in msg) {
		switch (type) {
			case "keepalive":
				// NOP - conn.lastActive is updated when receiving any valid message
				break;

			case "start":
				start(conn, extractMessage<StartMessage, typeof type>(msg, type));
				break;

			case "stop":
				stop();
				break;

			case "bitrate":
				if (getIsStreaming()) {
					const br = setBitrate(
						extractMessage<BitrateMessage, typeof type>(msg, type),
					);
					if (br != null) {
						broadcastMsgExcept(conn, "bitrate", { max_br: br });
					}
				}
				break;

			case "command":
				command(conn, extractMessage<CommandMessage, typeof type>(msg, type));
				break;

			case "netif":
				handleNetif(
					conn,
					extractMessage<NetworkInterfaceMessage, typeof type>(msg, type),
				);
				break;

			case "wifi":
				handleWifi(conn, extractMessage<WifiMessage, typeof type>(msg, type));
				break;

			case "modems":
				handleModems(
					conn,
					extractMessage<ModemsMessage, typeof type>(msg, type),
				);
				break;

			case "logout":
				handleLogout(conn);

				break;
		}
	}

	markConnectionActive(conn);
}

/* Misc commands */
function command(conn: WebSocket, cmd: string) {
	switch (cmd) {
		case "get_log":
			getLog(conn, "belaUI");
			return;
		case "get_syslog":
			getLog(conn);
			return;
	}

	if (getIsStreaming() || isUpdating()) {
		sendStatus(conn);
		return;
	}

	switch (cmd) {
		case "poweroff":
			spawnSync("poweroff");
			break;
		case "reboot":
			spawnSync("reboot");
			break;
		case "update":
			startSoftwareUpdate();
			break;
		case "start_ssh":
		case "stop_ssh":
			startStopSsh(conn, cmd);
			break;
		case "reset_ssh_pass":
			resetSshPassword(conn);
			break;
	}
}

function handleConfig(
	conn: WebSocket,
	msg: ConfigMessage["config"],
	isRemote: boolean,
) {
	// setPassword does its own authentication
	for (const type in msg) {
		switch (type) {
			case "password":
				setPassword(
					conn,
					extractMessage<ConfigPasswordMessage, typeof type>(msg, type),
					isRemote,
				);
				break;
		}
	}

	if (!isAuthedSocket(conn)) return;

	for (const type in msg) {
		switch (type) {
			case "remote_key":
				setRemoteKey(
					extractMessage<ConfigRemoteKeyMessage, typeof type>(msg, type),
				);
				break;
		}
	}
}

export function getSocketSenderId(conn: WebSocket) {
	return socketSenderIds.get(conn);
}

export function setSocketSenderId(conn: WebSocket, senderId: string) {
	socketSenderIds.set(conn, senderId);
}

export function deleteSocketSenderId(conn: WebSocket) {
	socketSenderIds.delete(conn);
}

export function markConnectionActive(
	conn: WebSocket,
	timestamp: number = getms(),
) {
	lastActiveSocket.set(conn, timestamp);
}

export function getLastActive(conn: WebSocket) {
	return lastActiveSocket.get(conn) ?? 0;
}

export function buildMsg(type: string, data?: unknown, id?: string | null) {
	const obj: Record<string, unknown> = {};
	obj[type] = data;
	obj.id = id;
	return JSON.stringify(obj);
}

export function broadcastMsgLocal(
	type: string,
	data: unknown,
	activeMin = 0,
	except?: WebSocket,
	authedOnly = true,
) {
	const msg = buildMsg(type, data);
	for (const c of wss.clients) {
		const lastActive = getLastActive(c);
		if (
			c !== except &&
			lastActive >= activeMin &&
			(!authedOnly || isAuthedSocket(c))
		) {
			c.send(msg);
		}
	}
	return msg;
}

export function broadcastMsg(
	type: string,
	data: unknown,
	activeMin = 0,
	authedOnly = true,
) {
	const msg = broadcastMsgLocal(type, data, activeMin, undefined, authedOnly);
	const remoteWs = getRemoteWebSocket();
	if (remoteWs && isAuthedSocket(remoteWs)) {
		remoteWs.send(msg);
	}
}

export function broadcastMsgExcept(
	conn: WebSocket,
	type: string,
	data: unknown,
) {
	broadcastMsgLocal(type, data, 0, conn);

	const remoteWs = getRemoteWebSocket();
	if (remoteWs && isAuthedSocket(remoteWs)) {
		const senderId = getSocketSenderId(conn);
		if (!senderId) return;

		const msg = buildMsg(type, data, senderId);
		remoteWs.send(msg);
	}
}
