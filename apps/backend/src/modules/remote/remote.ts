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

import {
	CLOUD_PROVIDERS,
	type CloudProviderEndpoint,
	type ProviderSelection,
} from "@ceraui/rpc/schemas";
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

const DEFAULT_PROTOCOL_VERSION = 16;
const DEFAULT_PROVIDER_ID: ProviderSelection = "ceralive";

/**
 * Get the current provider endpoint configuration
 */
function getCurrentProvider(): CloudProviderEndpoint {
	const config = getConfig();
	const providerId = config.remote_provider ?? DEFAULT_PROVIDER_ID;

	// Handle custom provider
	if (providerId === "custom" && config.custom_provider) {
		return {
			id: "custom",
			name: config.custom_provider.name,
			host: config.custom_provider.host,
			path: config.custom_provider.path ?? "/ws/remote",
			secure: config.custom_provider.secure ?? true,
			cloudUrl: config.custom_provider.cloudUrl,
		};
	}

	// Find predefined provider
	const provider = CLOUD_PROVIDERS.find((p) => p.id === providerId);
	if (provider) {
		return provider;
	}

	// Fallback to default (CeraLive)
	const defaultProvider = CLOUD_PROVIDERS[0];
	if (!defaultProvider) {
		throw new Error("No cloud providers configured");
	}
	return defaultProvider;
}

// Setup overrides take precedence over provider config
const remoteProtocolVersion =
	setup.remote_protocol_version ?? DEFAULT_PROTOCOL_VERSION;
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

	// Get current provider configuration
	const provider = getCurrentProvider();
	const protocol =
		setup.remote_endpoint_secure === false
			? "ws"
			: provider.secure
				? "wss"
				: "ws";
	const endpointHost = setup.remote_endpoint_host ?? provider.host;
	const endpointPath = setup.remote_endpoint_path ?? provider.path;
	const protocolVersion = provider.protocolVersion ?? remoteProtocolVersion;

	let fromCache = false;
	let host = endpointHost;
	try {
		const dnsRes = await dnsCacheResolve(endpointHost);
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

	logger.info(
		`remote: trying to connect to ${provider.name} (${endpointHost})`,
	);

	const remoteWsUrl = new URL(`${protocol}://${host}`);
	remoteWsUrl.pathname = endpointPath;

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
			dnsCacheValidate(endpointHost);
		}

		const config = getConfig();
		const auth_msg = {
			remote: {
				"auth/encoder": {
					key: config.remote_key,
					version: protocolVersion,
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

export type SetRemoteConfigParams = {
	remote_key: string;
	provider?: ProviderSelection;
	custom_provider?: {
		name: string;
		host: string;
		path?: string;
		secure?: boolean;
		cloudUrl?: string;
	};
};

export async function setRemoteConfig(params: SetRemoteConfigParams) {
	const config = getConfig();
	config.remote_key = params.remote_key;
	config.relay_server = undefined;
	config.relay_account = undefined;

	// Update provider if specified
	if (params.provider !== undefined) {
		config.remote_provider = params.provider;
	}

	// Update custom provider config if provided
	if (params.custom_provider !== undefined) {
		config.custom_provider = params.custom_provider;
	} else if (params.provider !== "custom") {
		// Clear custom provider if switching to a predefined provider
		config.custom_provider = undefined;
	}

	saveConfig();

	if (remoteWs) {
		remoteStatusHandled = true;
		remoteWs.terminate();
	}
	await remoteConnect();

	// Clear the remote relays when switching to a different remote key/provider
	if (await updateCachedRelays(undefined)) {
		broadcastMsg("relays", buildRelaysMsg());
	}

	broadcastMsg("config", config);
}

/**
 * @deprecated Use setRemoteConfig instead for provider support
 */
export async function setRemoteKey(key: string) {
	await setRemoteConfig({ remote_key: key });
}

/**
 * Get information about available cloud providers
 */
export function getCloudProviders() {
	return {
		providers: CLOUD_PROVIDERS,
		current: getCurrentProvider(),
	};
}
