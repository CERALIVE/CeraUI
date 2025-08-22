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

import assert from "node:assert";
import fs from "node:fs";

import { logger } from "../../helpers/logger.ts";
import { validatePortNo } from "../../helpers/number.ts";
import { writeTextFile } from "../../helpers/text-files.ts";

import { getConfig, saveConfig } from "../config.ts";
import {
	getAllRelaysRtt,
	updateBcrptServerConfig,
} from "../streaming/bcrpt.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

type RelayCache = {
	bcrp_key?: string;
	servers: Record<
		string,
		{
			bcrp_port?: string;
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

let relaysCache: RelayCache | undefined;
try {
	relaysCache = JSON.parse(
		fs.readFileSync(RELAYS_CACHE_FILE, "utf8"),
	) as RelayCache;
} catch (_err) {
	logger.warn("Failed to load the relays cache, starting with an empty cache");
}

export function getRelays() {
	return relaysCache;
}

export function buildRelaysMsg(): RelaysResponseMessage {
	const msg: RelaysResponseMessage = { servers: {}, accounts: {} };
	if (!relaysCache) return msg;

	// Simplify servers mapping using Object.entries
	const bcrptRelaysRtt = getAllRelaysRtt();
	Object.entries(relaysCache.servers).forEach(([id, srv]) => {
		if (!srv) return;
		const rtt = bcrptRelaysRtt?.[id];
		const status =
			rtt !== undefined ? (rtt <= 80 ? "🟢" : rtt <= 150 ? "🟡" : "🔴") : "";
		const prefix = status ? `${status} ` : "";
		const suffix = rtt !== undefined ? ` (${rtt} ms)` : "";
		msg.servers[id] = {
			name: `${prefix}${srv.name}${suffix}`,
			default: srv.default,
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

export async function updateCachedRelays(relays: RelayCache | undefined) {
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

export async function handleRemoteRelays(
	msg: ValidateRemoteRelaysMessage["relays"],
) {
	const validatedUpdate = validateRemoteRelays(msg);
	if (!validatedUpdate) return;

	const hasUpdated = await updateCachedRelays(validatedUpdate);
	if (hasUpdated) {
		broadcastMsg("relays", buildRelaysMsg());
		if (convertManualToRemoteRelay()) {
			saveConfig();
			broadcastMsg("config", getConfig());
		}
		updateBcrptServerConfig();
	}
}
