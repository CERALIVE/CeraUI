/*
    CeraUI - web UI for the CERALIVE project
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

/**
 * SRTLA transport adapter.
 *
 * A golden re-implementation of the relay/manual endpoint resolution that lives
 * inline in `streaming.ts` (`validateConfig`, lines 172-197): for the same
 * input it produces an identical `{ addr, port, streamid }`.
 *
 * The one additive behaviour over the original is provider-namespace stripping:
 * `relay_server`/`relay_account` may arrive flat ("0") or namespaced
 * ("ceralive:0"). The namespace is stripped via `parseNamespacedRelayId` before
 * the flat relays-cache lookup, so both forms resolve identically. Flat ids
 * (no separator) pass through unchanged, preserving golden parity.
 */

import { parseNamespacedRelayId } from "../../../helpers/config-schemas.ts";
import { validatePortNo } from "../../../helpers/number.ts";

import type {
	ResolvedEndpoint,
	TransportAdapter,
	TransportConfig,
	TransportDescriptor,
} from "./types.ts";

/** Strip a provider namespace (if present) to get the flat cache lookup id. */
function relayCacheId(id: string): string {
	return parseNamespacedRelayId(id).serverId;
}

export const srtlaAdapter: TransportAdapter = {
	protocol: "srtla",

	validate(cfg: TransportConfig): void {
		// Validation === "is this resolvable?" — resolve and discard, so the
		// throw messages stay in lock-step with resolveEndpoint.
		this.resolveEndpoint(cfg);
	},

	resolveEndpoint(cfg: TransportConfig): ResolvedEndpoint {
		const relays = cfg.relays;

		// SRTLA addr and port
		let addr: string;
		let port: number;
		if (relays && cfg.relay_server) {
			const relayServer = relays.servers[relayCacheId(cfg.relay_server)];
			if (!relayServer) throw new Error("Invalid relay server");
			addr = relayServer.addr;
			port = relayServer.port;
		} else {
			if (typeof cfg.srtla_addr !== "string")
				throw new Error("Invalid SRTLA address");
			addr = cfg.srtla_addr.trim();

			const validated = validatePortNo(cfg.srtla_port);
			if (!validated) throw new Error(`Invalid SRTLA port '${cfg.srtla_port}'`);
			port = validated;
		}

		// stream ID
		let streamid: string;
		if (relays && cfg.relay_server && cfg.relay_account) {
			const relayAccount = relays.accounts[relayCacheId(cfg.relay_account)];
			if (!relayAccount) throw new Error("Invalid relay account specified!");
			streamid = relayAccount.ingest_key;
		} else {
			if (typeof cfg.srt_streamid !== "string")
				throw new Error("SRT streamid not specified");
			streamid = cfg.srt_streamid;
		}

		return { addr, port, streamid };
	},

	describe(): TransportDescriptor {
		return { protocol: "srtla", label: "SRTLA", implemented: true };
	},
};
