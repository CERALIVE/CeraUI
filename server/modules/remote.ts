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

/* Remote */
/*
  A brief remote protocol version history:
  1 - initial remote release
  2 - belaUI password setting feature
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
*/

import assert from "node:assert";
import fs from "node:fs";

import WebSocket, { type RawData } from "ws";

import { logger } from "../helpers/logger.ts";
import { validatePortNo } from "../helpers/number.ts";
import { getms } from "../helpers/time.ts";
import { extractMessage } from "../helpers/types.ts";

import { addAuthedSocket } from "./auth.ts";
import { getConfig, saveConfig } from "./config.ts";
import { dnsCacheResolve, dnsCacheValidate } from "./dns.ts";
import { queueUpdateGw } from "./gateways.ts";
import { ACTIVE_TO } from "./shared.ts";
import { type StatusResponseMessage, sendInitialStatus } from "./status.ts";
import { writeTextFile } from "./text-files.ts";
import {
	broadcastMsg,
	broadcastMsgLocal,
	deleteSocketSenderId,
	getLastActive,
	markConnectionActive,
	setSocketSenderId,
} from "./websocket-server.ts";
import { type Message, handleMessage } from "./websocket-server.ts";

type RemoteAuthEncoderMessage = {
	"auth/encoder": unknown;
};

type RemoteMessage = ValidateRemoteRelaysMessage | RemoteAuthEncoderMessage;

const RELAYS_CACHE_FILE = "relays_cache.json";

const remoteProtocolVersion = 14;
const remoteEndpointHost = "remote.belabox.net";
const remoteEndpointPath = "/ws/remote";
const remoteTimeout = 5000;
const remoteConnectTimeout = 10000;

let remoteWs: WebSocket | undefined = undefined;
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

type RelayCache = {
	servers: Record<
		string,
		{
			type: string;
			name: string;
			default?: true;
			addr: string;
			port: number;
		}
	>;
	accounts: Record<
		string,
		{
			name: string;
			ingest_key: string;
			disabled?: true;
		}
	>;
};

let relaysCache: RelayCache | undefined;
try {
	relaysCache = JSON.parse(
		fs.readFileSync(RELAYS_CACHE_FILE, "utf8"),
	) as RelayCache;
} catch (err) {
	logger.warn("Failed to load the relays cache, starting with an empty cache");
}

export function getRelays() {
	return relaysCache;
}

type RelaysResponseMessage = {
	servers: Record<
		string,
		{
			name: string;
			default?: true;
		}
	>;
	accounts: Record<
		string,
		{
			name: string;
			disabled?: true;
		}
	>;
};

export function buildRelaysMsg() {
	const msg: RelaysResponseMessage = {
		servers: {},
		accounts: {},
	};

	if (!relaysCache) return msg;

	for (const s in relaysCache.servers) {
		const relayServer = relaysCache.servers[s];
		if (!relayServer) continue;

		msg.servers[s] = {
			name: relayServer.name,
			default: relayServer.default,
		};
	}

	for (const a in relaysCache.accounts) {
		const relayAccount = relaysCache.accounts[a];
		if (!relayAccount) continue;

		msg.accounts[a] = {
			name: relayAccount.name + (relayAccount.disabled ? " [disabled]" : ""),
			disabled: relayAccount.disabled,
		};
	}

	return msg;
}

async function updateCachedRelays(relays: RelayCache | undefined) {
	try {
		assert.deepStrictEqual(relays, relaysCache);
	} catch (err) {
		logger.debug("updated the relays cache", relays);
		relaysCache = relays;
		await writeTextFile(RELAYS_CACHE_FILE, JSON.stringify(relays));
		return true;
	}
}

type ValidateRemoteRelaysMessage = {
	relays: {
		servers: Record<
			string,
			{
				type?: unknown;
				name?: unknown;
				addr?: unknown;
				port?: unknown;
				default?: unknown;
			}
		>;
		accounts: Record<
			string,
			{
				name?: unknown;
				ingest_key?: unknown;
				disabled?: unknown;
			}
		>;
	};
};

function validateRemoteRelays(msg: ValidateRemoteRelaysMessage["relays"]) {
	try {
		const out: RelayCache = { servers: {}, accounts: {} };
		for (const r_id in msg.servers) {
			const r = msg.servers[r_id];
			if (!r) continue;

			if (
				r.type !== "srtla" ||
				typeof r.name !== "string" ||
				typeof r.addr !== "string"
			)
				continue;
			if (r.default && r.default !== true) continue;

			const port = validatePortNo(r.port as string);
			if (!port) continue;

			out.servers[r_id] = {
				type: r.type,
				name: r.name,
				addr: r.addr,
				port: port,
			};
			if (r.default) out.servers[r_id].default = true;
		}

		for (const a_id in msg.accounts) {
			const a = msg.accounts[a_id];
			if (!a || typeof a.name !== "string" || typeof a.ingest_key !== "string")
				continue;

			out.accounts[a_id] = { name: a.name, ingest_key: a.ingest_key };
			if (a.disabled) out.accounts[a_id].disabled = true;
		}

		if (Object.keys(out.servers).length < 1) return;

		return out;
	} catch (err) {
		return undefined;
	}
}

export function convertManualToRemoteRelay() {
	if (!relaysCache) return false;

	let modified = false;
	const config = getConfig();
	if (!config.relay_server && config.srtla_addr && config.srtla_port) {
		for (const s in relaysCache.servers) {
			const server = relaysCache.servers[s];
			if (!server) continue;

			if (
				server.addr.toLowerCase() === config.srtla_addr.toLowerCase() &&
				server.port === config.srtla_port
			) {
				config.relay_server = s;
				modified = true;
				break;
			}
		}
	}

	// If not using a relay server, don't try to convert the streamid to a relay account
	if (!config.relay_server) {
		return false;
	}

	if (config.srtla_addr || config.srtla_port) {
		config.srtla_addr = undefined;
		config.srtla_port = undefined;
		modified = true;
	}

	if (!config.relay_account && config.srt_streamid) {
		for (const a in relaysCache.accounts) {
			const account = relaysCache.accounts[a];
			if (!account) continue;

			if (account.ingest_key === config.srt_streamid) {
				config.relay_account = a;
				modified = true;
				break;
			}
		}
	}

	if (config.relay_account && config.srt_streamid) {
		config.srt_streamid = undefined;
		modified = true;
	}

	return modified;
}

async function handleRemoteRelays(msg: ValidateRemoteRelaysMessage["relays"]) {
	const validatedUpdate = validateRemoteRelays(msg);
	if (!validatedUpdate) return;

	const hasUpdated = await updateCachedRelays(validatedUpdate);
	if (hasUpdated) {
		broadcastMsg("relays", buildRelaysMsg());
		if (convertManualToRemoteRelay()) {
			saveConfig();
			broadcastMsg("config", getConfig());
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
	} catch (err) {
		return remoteRetry();
	}

	logger.info("remote: trying to connect");

	remoteStatusHandled = false;
	remoteWs = new WebSocket(`wss://${host}${remoteEndpointPath}`);
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
