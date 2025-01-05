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
import fs from "node:fs";
import assert from "node:assert";

import WebSocket, { type RawData } from "ws";

import { validatePortNo } from "../helpers/number.ts";
import { getms } from "../helpers/time.ts";
import { extractMessage } from "../helpers/types.ts";

import { getConfig, saveConfig } from "./config.ts";
import {
	broadcastMsg,
	broadcastMsgLocal,
	deleteSocketSenderId,
	getLastActive,
	markConnectionActive,
	setSocketSenderId,
} from "./websocket-server.ts";
import { writeTextFile } from "./text-files.ts";
import { dnsCacheResolve, dnsCacheValidate } from "./dns.ts";
import { addAuthedSocket, deleteAuthedSocket } from "./auth.ts";
import { sendInitialStatus } from "./status.ts";
import { queueUpdateGw } from "./gateways.ts";
import { handleMessage, type Message } from "./websocket-server.ts";
import { ACTIVE_TO } from "./shared.ts";

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
			case "auth/encoder":
				const value = extractMessage<RemoteAuthEncoderMessage, typeof type>(
					msg,
					type,
				);
				if (value === true) {
					addAuthedSocket(conn);
					sendInitialStatus(conn);
					broadcastMsgLocal("status", { remote: true }, getms() - ACTIVE_TO);
					console.log("remote: authenticated");
				} else {
					broadcastMsgLocal(
						"status",
						{ remote: { error: "key" } },
						getms() - ACTIVE_TO,
					);
					remoteStatusHandled = true;
					conn.terminate();
					console.log("remote: invalid key");
				}
				break;
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
	console.log("Failed to load the relays cache, starting with an empty cache");
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

	if (relaysCache) {
		for (const s in relaysCache.servers) {
			msg.servers[s] = { name: relaysCache.servers[s]!.name };
			if (relaysCache.servers[s]!.default) msg.servers[s].default = true;
		}
		for (const a in relaysCache.accounts) {
			msg.accounts[a] = { name: relaysCache.accounts[a]!.name };
			if (relaysCache.accounts[a]!.disabled) {
				msg.accounts[a].name += " [disabled]";
				msg.accounts[a].disabled = true;
			}
		}
	}

	return msg;
}

async function updateCachedRelays(relays: RelayCache | undefined) {
	try {
		assert.deepStrictEqual(relays, relaysCache);
	} catch (err) {
		console.log("updated the relays cache:");
		console.log(relays);
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
			const r = msg.servers[r_id]!;
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
			const a = msg.accounts[a_id]!;
			if (typeof a.name !== "string" || typeof a.ingest_key !== "string")
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
			const server = relaysCache.servers[s]!;
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
		delete config.srtla_addr;
		delete config.srtla_port;
		modified = true;
	}

	if (!config.relay_account && config.srt_streamid) {
		for (const a in relaysCache.accounts) {
			const account = relaysCache.accounts[a]!;
			if (account.ingest_key === config.srt_streamid) {
				config.relay_account = a;
				modified = true;
				break;
			}
		}
	}

	if (config.relay_account && config.srt_streamid) {
		delete config.srt_streamid;
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
			delete parsedMessage.remote;
		}

		if (Object.keys(msg).length >= 1) {
			setSocketSenderId(conn, parsedMessage.id);
			handleMessage(conn, parsedMessage as unknown as Message, true);
			deleteSocketSenderId(conn);
		}

		markConnectionActive(conn);
	} catch (err) {
		if (err instanceof Error) {
			console.log(`Error handling remote message: ${err.message}`);
		}
	}
}

let remoteConnectTimer: NodeJS.Timeout | undefined;

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

	let fromCache = false;
	const config = getConfig();
	if (config.remote_key) {
		let host = remoteEndpointHost;
		try {
			const dnsRes = await dnsCacheResolve(remoteEndpointHost);
			fromCache = dnsRes.fromCache;

			if (fromCache) {
				host = dnsRes.addrs[Math.floor(Math.random() * dnsRes.addrs.length)]!;
				queueUpdateGw();
				console.log(`remote: DNS lookup failed, using cached address ${host}`);
			}
		} catch (err) {
			return remoteRetry();
		}
		console.log(`remote: trying to connect`);

		remoteStatusHandled = false;
		remoteWs = new WebSocket(`wss://${host}${remoteEndpointPath}`, {
			host: remoteEndpointHost,
			headers: { Host: remoteEndpointHost },
		});
		deleteAuthedSocket(remoteWs);
		// Set a longer initial connection timeout - mostly to deal with slow DNS
		markConnectionActive(
			remoteWs,
			getms() + remoteConnectTimeout - remoteTimeout,
		);
		remoteWs.on("error", function (err) {
			console.log("remote error: " + err.message);
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
		remoteWs.on("close", () => remoteClose(remoteWs!));
		remoteWs.on("message", (msg) => remoteHandleMsg(remoteWs!, msg));
	}
}

function remoteKeepalive() {
	if (remoteWs) {
		const lastActive = getLastActive(remoteWs);
		if (lastActive + remoteTimeout < getms()) {
			remoteWs.terminate();
		}
	}
}

remoteConnect();
setInterval(remoteKeepalive, 1000);

export async function setRemoteKey(key: string) {
	const config = getConfig();
	config.remote_key = key;
	delete config.relay_server;
	delete config.relay_account;
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
