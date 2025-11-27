/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

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

/* Remote */
/*
  A brief remote protocol version history:
  1 - initial remote release
  2 - CeraLive password setting feature
  3 - apt update feature
  4 - ssh manager
  5 - wifi manager
  6 - notification sytem
  7 - support for config.bitrate_overlay
  8 - support for netif error
  9 - support for the get_log command
  10 - support for the get_syslog command
  11 - support for the asrc and acodec settings
  12 - support for receiving relay accounts and relay servers
  13 - wifi hotspot mode
  14 - support for the modem manager
  15 - support for BCRPT
  16 - support for autostart
*/

import WebSocket, { type RawData } from "ws";

import { logger } from "../../helpers/logger.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import { extractMessage } from "../../helpers/types.ts";

import { getConfig, saveConfig } from "../config.ts";
import { dnsCacheResolve, dnsCacheValidate } from "../network/dns.ts";
import { queueUpdateGw } from "../network/gateways.ts";
import { setup } from "../setup.ts";
import { addAuthedSocket } from "../ui/auth.ts";
import { type StatusResponseMessage, sendInitialStatus } from "../ui/status.ts";
import {
	broadcastMsg,
	broadcastMsgLocal,
	deleteSocketSenderId,
	getLastActive,
	handleMessage,
	type Message,
	markConnectionActive,
	setSocketSenderId,
} from "../ui/websocket-server.ts";

import {
	buildRelaysMsg,
	handleRemoteRelays,
	updateCachedRelays,
	type ValidateRemoteRelaysMessage,
} from "./remote-relays.ts";

type RemoteAuthEncoderMessage = {
	"auth/encoder": unknown;
};

type RemoteMessage = ValidateRemoteRelaysMessage | RemoteAuthEncoderMessage;

const remoteProtocolVersion = setup.remote_protocol_version ?? 16;
const remoteEndpointProtocol =
	setup.remote_endpoint_secure === false ? "ws" : "wss";
const remoteEndpointHost = setup.remote_endpoint_host ?? "remote.belabox.net";
const remoteEndpointPath = setup.remote_endpoint_path ?? "/ws/remote";
const remoteTimeout = 5000;
const remoteConnectTimeout = 10000;

let remoteWs: WebSocket | undefined;
let remoteStatusHandled = false;

export function getRemoteWebSocket() {
	return remoteWs;
}

function handleRemote(conn: WebSocket, msg: RemoteMessage) {
	for (const type in msg) {
		switch (type) {
			case "auth/encoder": {
				const value = extractMessage<RemoteAuthEncoderMessage, typeof type>(
					msg,
					type,
				);
				if (value === true) {
					addAuthedSocket(conn);
					sendInitialStatus(conn);
					broadcastMsgLocal(
						"status",
						{ remote: true } satisfies StatusResponseMessage,
						getms() - ACTIVE_TO,
					);
					logger.info("remote: authenticated");
				} else {
					broadcastMsgLocal(
						"status",
						{ remote: { error: "key" } } satisfies StatusResponseMessage,
						getms() - ACTIVE_TO,
					);
					remoteStatusHandled = true;
					conn.terminate();
					logger.warn("remote: invalid key");
				}
				break;
			}
			case "relays":
				handleRemoteRelays(
					extractMessage<ValidateRemoteRelaysMessage, typeof type>(msg, type),
				);
				break;
		}
	}
}

function remoteHandleMsg(conn: WebSocket, msg: RawData) {
	try {
		const parsedMessage = JSON.parse(String(msg)) as {
			id: string;
		} & ({ remote?: RemoteMessage } | Message);
		if ("remote" in parsedMessage && parsedMessage.remote) {
			handleRemote(conn, parsedMessage.remote);
			parsedMessage.remote = undefined;
		}

		if (Object.keys(msg).length >= 1) {
			setSocketSenderId(conn, parsedMessage.id);
			handleMessage(conn, parsedMessage as unknown as Message, true);
			deleteSocketSenderId(conn);
		}

		markConnectionActive(conn);
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`Error handling remote message: ${err.message}`);
		}
	}
}

let remoteConnectTimer: ReturnType<typeof setTimeout> | undefined;

function remoteRetry() {
	queueUpdateGw();
	remoteConnectTimer = setTimeout(remoteConnect, 1000);
}

function remoteClose(conn: WebSocket) {
	remoteRetry();

	conn.removeListener("close", remoteClose);
	conn.removeListener("message", (msg) => remoteHandleMsg(conn, msg));
	remoteWs = undefined;

	if (!remoteStatusHandled) {
		broadcastMsgLocal(
			"status",
			{ remote: { error: "network" } },
			getms() - ACTIVE_TO,
		);
	}
}

async function remoteConnect() {
	if (remoteConnectTimer !== undefined) {
		clearTimeout(remoteConnectTimer);
		remoteConnectTimer = undefined;
	}

	const config = getConfig();
	if (!config.remote_key) return;

	let fromCache = false;
	let host = remoteEndpointHost;
	try {
		const dnsRes = await dnsCacheResolve(remoteEndpointHost);
		fromCache = dnsRes.fromCache;

		if (fromCache) {
			const cachedHost =
				dnsRes.addrs[Math.floor(Math.random() * dnsRes.addrs.length)];
			if (!cachedHost) throw "No cached address";

			host = cachedHost;
			queueUpdateGw();
			logger.warn(`remote: DNS lookup failed, using cached address ${host}`);
		}
	} catch (_err) {
		return remoteRetry();
	}

	logger.info("remote: trying to connect");

	const remoteWsUrl = new URL(`${remoteEndpointProtocol}://${host}`);
	remoteWsUrl.pathname = remoteEndpointPath;

	remoteStatusHandled = false;
	remoteWs = new WebSocket(remoteWsUrl);
	markConnectionActive(
		remoteWs,
		getms() + remoteConnectTimeout - remoteTimeout,
	);
	remoteWs.on("error", (err) => {
		logger.error(`remote error: ${err.message}`);
	});
	remoteWs.on("open", function () {
		if (!fromCache) {
			dnsCacheValidate(remoteEndpointHost);
		}

		const config = getConfig();
		const auth_msg = {
			remote: {
				"auth/encoder": {
					key: config.remote_key,
					version: remoteProtocolVersion,
				},
			},
		};
		this.send(JSON.stringify(auth_msg));
	});
	remoteWs.on("close", () => {
		if (remoteWs) remoteClose(remoteWs);
	});
	remoteWs.on("message", (msg) => {
		if (remoteWs) remoteHandleMsg(remoteWs, msg);
	});
}

function remoteKeepalive() {
	if (remoteWs) {
		const lastActive = getLastActive(remoteWs);
		if (lastActive + remoteTimeout < getms()) {
			remoteWs.terminate();
		}
	}
}

export async function initRemote() {
	await remoteConnect();
	setInterval(remoteKeepalive, 1000);
}

export async function setRemoteKey(key: string) {
	const config = getConfig();
	config.remote_key = key;
	config.relay_server = undefined;
	config.relay_account = undefined;
	saveConfig();

	if (remoteWs) {
		remoteStatusHandled = true;
		remoteWs.terminate();
	}
	await remoteConnect();

	// Clear the remote relays when switching to a different remote key
	if (await updateCachedRelays(undefined)) {
		broadcastMsg("relays", buildRelaysMsg());
	}

	broadcastMsg("config", config);
}
