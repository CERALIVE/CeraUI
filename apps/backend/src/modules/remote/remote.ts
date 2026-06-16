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
	type SubscriptionStatus,
} from "@ceraui/rpc/schemas";
import WebSocket, { type RawData } from "ws";

import { logger } from "../../helpers/logger.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import { extractMessage } from "../../helpers/types.ts";

import { getConfig, saveConfig } from "../config.ts";
import { dnsCacheResolve, dnsCacheValidate } from "../network/dns.ts";
import { queueUpdateGw } from "../network/gateways.ts";
import { verifyStubDeviceToken } from "../pairing/device-token.ts";
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

/** Proto-v16 `auth/encoder` payload presented on every remote reconnect. */
export type AuthEncoderPayload = {
	key: string;
	version: number;
	sub_status?: SubscriptionStatus;
};

/**
 * Build the `auth/encoder` payload presented on every remote reconnect.
 *
 * The stored credential (`config.remote_key`) IS the authentication material:
 * for a paired device it is the platform-issued device token (ADR-0006); for an
 * unpaired/legacy device it is the opaque operator key. The same `key` field
 * carries either, so the channel keeps working unchanged.
 *
 * When the credential parses as a device token, its `sub_status` claim is read
 * locally (no DB round-trip, via {@link verifyStubDeviceToken}) and presented
 * alongside the key so the server learns the device's subscription standing at
 * authentication time. Whether that claim is TRUSTED is gated on
 * `PASETO_PUBLIC_KEY` (ADR-0006 D2): when the Ed25519 public key is provisioned
 * the claim is read only after a REAL `v4.public` signature check — a forged,
 * unsigned, expired, or wrong-key token is refused and presents `key` + `version`
 * alone; when no key is provisioned the MVP opaque path validates the claim shape
 * and the `iat`/`exp` window WITHOUT a signature check (key-absent fallback). A
 * legacy opaque key reads back no claims either way, so only `key` + `version`
 * are sent — backward-compatible.
 *
 * Edge E-1: `sub_status` reflects subscription standing AT TOKEN ISSUANCE, not
 * live billing state. Real-time enforcement is bounded by the token's `exp` plus
 * a re-pair: a subscription lapse mid-token is not observed on the channel until
 * the token expires and the device re-pairs. Mid-token revocation is explicitly
 * out of scope this cycle (no token refresh/revocation path).
 */
export function buildAuthEncoderPayload(
	credential: string,
	version: number,
	now: number = Date.now(),
): AuthEncoderPayload {
	const claims = verifyStubDeviceToken(credential, now);
	if (claims) {
		return { key: credential, version, sub_status: claims.sub_status };
	}
	return { key: credential, version };
}

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
		if (!config.remote_key) return;
		const payload = buildAuthEncoderPayload(config.remote_key, protocolVersion);
		if (payload.sub_status) {
			logger.info(
				`remote: presenting device token (standing=${payload.sub_status})`,
			);
		}
		const auth_msg = { remote: { "auth/encoder": payload } };
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
	remote_key?: string;
	token?: string;
	provider?: ProviderSelection;
	custom_provider?: {
		name: string;
		host: string;
		path?: string;
		secure?: boolean;
		cloudUrl?: string;
	};
};

/**
 * Resolve the effective remote key. A platform-issued device `token` (claim-code
 * pairing, ADR-0006) takes precedence over an operator-entered `remote_key`; the
 * channel presents whichever this returns on every reconnect.
 */
export function resolveRemoteKey(
	params: Pick<SetRemoteConfigParams, "remote_key" | "token">,
): string | undefined {
	return params.token ?? params.remote_key;
}

export async function setRemoteConfig(params: SetRemoteConfigParams) {
	const config = getConfig();
	const remoteKey = resolveRemoteKey(params);
	if (remoteKey === undefined) {
		throw new Error("setRemoteConfig requires either remote_key or token");
	}
	config.remote_key = remoteKey;
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
 * @deprecated Use setRemoteConfig instead for provider support. Retained for
 * backward compatibility: existing paired devices and operator-entered keys still
 * flow through here, writing the opaque credential as the active `remote_key`.
 *
 * TODO(high-priority-debt): forced re-pair migration (D3 default) — when PASETO is
 * ungated, paired-but-tokenless devices must re-pair. Use oracle/ultrabrain to
 * choose forced-re-pair vs dual-auth window, accounting for CeraUI being
 * self-hosted on the device (offline-capable verification, no runtime CA, minimal
 * field re-pair friction).
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
