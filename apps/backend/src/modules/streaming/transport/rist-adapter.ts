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
 * RIST transport adapter (Task 20).
 *
 * Resolves a relay/manual selection to the same `{ addr, port, streamid }`
 * endpoint shape as the SRTLA adapter, with two RIST-specific differences:
 *
 *  - RIST simple profile (librist) carries RTP on an even data port and RTCP on
 *    `port + 1`, so the resolved data port MUST be even — an odd port is rejected.
 *  - A stream id is optional for RIST: the account `ingest_key` or a manual
 *    `srt_streamid` is forwarded when present, but its absence is not an error
 *    (RIST has no SRT-style stream id requirement).
 *
 * Promotion from the reserved placeholder is gated by the RIST capability at the
 * `resolve-endpoint` layer; this adapter assumes the gate has already passed.
 */

import { parseNamespacedRelayId } from "../../../helpers/config-schemas.ts";
import { validatePortNo } from "../../../helpers/number.ts";

import type {
	ResolvedEndpoint,
	TransportAdapter,
	TransportConfig,
	TransportDescriptor,
} from "./types.ts";

function relayCacheId(id: string): string {
	return parseNamespacedRelayId(id).serverId;
}

export const ristAdapter: TransportAdapter = {
	protocol: "rist",

	validate(cfg: TransportConfig): void {
		this.resolveEndpoint(cfg);
	},

	resolveEndpoint(cfg: TransportConfig): ResolvedEndpoint {
		const relays = cfg.relays;

		let addr: string;
		let port: number;
		if (relays && cfg.relay_server) {
			const relayServer = relays.servers[relayCacheId(cfg.relay_server)];
			if (!relayServer) throw new Error("Invalid relay server");
			addr = relayServer.addr;
			port = relayServer.port;
		} else {
			if (typeof cfg.srtla_addr !== "string")
				throw new Error("Invalid RIST address");
			addr = cfg.srtla_addr.trim();

			const validated = validatePortNo(cfg.srtla_port);
			if (!validated) throw new Error(`Invalid RIST port '${cfg.srtla_port}'`);
			port = validated;
		}

		// Simple-profile data port is even (RTCP rides port + 1).
		if (port % 2 !== 0)
			throw new Error(`RIST requires an even data port (got ${port})`);

		let streamid = "";
		if (relays && cfg.relay_server && cfg.relay_account) {
			const relayAccount = relays.accounts[relayCacheId(cfg.relay_account)];
			if (!relayAccount) throw new Error("Invalid relay account specified!");
			streamid = relayAccount.ingest_key;
		} else if (typeof cfg.srt_streamid === "string") {
			streamid = cfg.srt_streamid;
		}

		return { addr, port, streamid };
	},

	describe(): TransportDescriptor {
		return { protocol: "rist", label: "RIST", implemented: true };
	},
};
