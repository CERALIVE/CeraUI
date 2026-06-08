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

import assert from "node:assert";

import { loadJsonConfig } from "../../helpers/config-loader.ts";
import {
	DEFAULT_RELAY_PROVIDER_ID,
	namespacedRelayId,
	parseNamespacedRelayId,
	RELAYS_CACHE_DEFAULTS,
	type RelaysCache,
	type RuntimeConfig,
	relaysCacheSchema,
} from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { validatePortNo } from "../../helpers/number.ts";
import { writeTextFile } from "../../helpers/text-files.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";

import { getConfig, saveConfig } from "../config.ts";
import { getRelayRtt, updateBcrptServerConfig } from "../streaming/bcrpt.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

// Use the shared RelaysCache type from config-schemas

type RelaysResponseMessage = {
	servers: Record<
		string,
		{
			name: string;
			rtt?: number;
			default?: true;
			addr?: string;
			port?: number;
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

export type ValidateRemoteRelaysMessage = {
	relays: {
		bcrp_key?: string;
		servers: Record<
			string,
			{
				type?: unknown;
				name?: unknown;
				addr?: unknown;
				port?: number;
				default?: unknown;
				bcrp_port?: string;
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

const RELAYS_CACHE_FILE = "relays_cache.json";

// Load relays cache with Zod validation
const relaysCacheResult = await loadJsonConfig(
	RELAYS_CACHE_FILE,
	relaysCacheSchema,
	RELAYS_CACHE_DEFAULTS,
);
let relaysCache: RelaysCache | undefined = relaysCacheResult.loaded
	? relaysCacheResult.data
	: undefined;

export function getRelays() {
	return relaysCache;
}

// Mock-only in-memory setter: no disk write (unlike updateCachedRelays), so
// the dev working dir never gets a relays_cache.json. No-op in production.
export function setRelaysCacheMock(data: RelaysCache | undefined): void {
	if (!shouldUseMocks()) return;
	relaysCache = data;
}

export function buildRelaysMsg(): RelaysResponseMessage {
	const msg: RelaysResponseMessage = { servers: {}, accounts: {} };
	if (!relaysCache) return msg;

	Object.entries(relaysCache.servers).forEach(([id, srv]) => {
		if (!srv) return;
		const rtt = getRelayRtt(id);
		msg.servers[id] = {
			name: srv.name,
			rtt,
			default: srv.default,
			addr: srv.addr,
			port: srv.port,
		};
	});

	// Simplify accounts mapping with clearer variable names
	Object.entries(relaysCache.accounts).forEach(([id, relayAccount]) => {
		if (!relayAccount) return;
		const displayName = `${relayAccount.name}${relayAccount.disabled ? " [disabled]" : ""}`;
		msg.accounts[id] = { name: displayName, disabled: relayAccount.disabled };
	});

	return msg;
}

export async function updateCachedRelays(relays: RelaysCache | undefined) {
	try {
		assert.deepStrictEqual(relays, relaysCache);
	} catch (_err) {
		logger.debug("updated the relays cache", relays);
		relaysCache = relays;
		await writeTextFile(RELAYS_CACHE_FILE, JSON.stringify(relays));
		return true;
	}
}

function validateRemoteRelays(msg: ValidateRemoteRelaysMessage["relays"]) {
	try {
		const out: RelaysCache = { servers: {}, accounts: {} };
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

			const port = validatePortNo(r.port);
			if (!port) continue;

			out.servers[r_id] = {
				type: r.type,
				name: r.name,
				addr: r.addr,
				port: port,
			};
			if (r.bcrp_port && out.servers[r_id]) {
				out.servers[r_id].bcrp_port = r.bcrp_port;
			}
			if (r.default) out.servers[r_id].default = true;
		}

		for (const a_id in msg.accounts) {
			const a = msg.accounts[a_id];
			if (!a || typeof a.name !== "string" || typeof a.ingest_key !== "string")
				continue;

			out.accounts[a_id] = { name: a.name, ingest_key: a.ingest_key };
			if (a.disabled) out.accounts[a_id].disabled = true;
		}

		if (msg.bcrp_key !== undefined) {
			if (typeof msg.bcrp_key !== "string") return;
			out.bcrp_key = msg.bcrp_key;
		}

		if (Object.keys(out.servers).length < 1) return;

		return out;
	} catch (_err) {
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

function pickPreferredServerId(relays: RelaysCache): string | undefined {
	const ids = Object.keys(relays.servers);
	const defaultId = ids.find((id) => relays.servers[id]?.default === true);
	return defaultId ?? ids[0];
}

function pickPreferredAccountId(relays: RelaysCache): string | undefined {
	return Object.keys(relays.accounts).find(
		(id) => !relays.accounts[id]?.disabled,
	);
}

export function computeSubscriptionPreload(
	config: RuntimeConfig,
	relays: RelaysCache,
	providerId: string,
): boolean {
	let modified = false;

	if (config.relay_server) {
		const { providerId: selectedProvider } = parseNamespacedRelayId(
			config.relay_server,
		);
		if (selectedProvider !== undefined && selectedProvider !== providerId) {
			config.relay_server = undefined;
			config.relay_account = undefined;
			config.relay_streamid_override = undefined;
			modified = true;
		}
	}

	if (!config.relay_server) {
		const serverId = pickPreferredServerId(relays);
		if (serverId) {
			config.relay_server = namespacedRelayId(providerId, serverId);
			modified = true;
		}
	}

	if (!config.relay_account) {
		const accountId = pickPreferredAccountId(relays);
		if (accountId) {
			config.relay_account = namespacedRelayId(providerId, accountId);
			const ingestKey = relays.accounts[accountId]?.ingest_key;
			if (ingestKey) config.relay_streamid_override = ingestKey;
			modified = true;
		}
	}

	if (modified) config.detectionMethod = "subscription";

	return modified;
}

export function autoPreloadSubscriptionRelays(): boolean {
	if (!relaysCache) return false;

	const config = getConfig();
	if (!config.remote_key) return false;

	const providerId = config.remote_provider ?? DEFAULT_RELAY_PROVIDER_ID;
	return computeSubscriptionPreload(config, relaysCache, providerId);
}

export async function handleRemoteRelays(
	msg: ValidateRemoteRelaysMessage["relays"],
) {
	const validatedUpdate = validateRemoteRelays(msg);
	if (!validatedUpdate) return;

	const hasUpdated = await updateCachedRelays(validatedUpdate);
	if (hasUpdated) {
		broadcastMsg("relays", buildRelaysMsg());
		let configModified = convertManualToRemoteRelay();
		if (autoPreloadSubscriptionRelays()) configModified = true;
		if (configModified) {
			saveConfig();
			broadcastMsg("config", getConfig());
		}
		updateBcrptServerConfig();
	}
}
