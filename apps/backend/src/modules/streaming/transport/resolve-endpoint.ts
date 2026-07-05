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
 * Stream-endpoint resolution — the wiring layer between `streaming.ts` and the
 * Task 7 transport registry.
 *
 * This module owns the three concerns that sit ABOVE the protocol adapter:
 *
 *   1. Protocol selection — pick the adapter via `relay_protocol` (input wins,
 *      then a caller-supplied fallback, then `srtla`).
 *   2. Provider-namespace stripping — `relay_server`/`relay_account` may arrive
 *      flat ("0") or provider-namespaced ("ceralive:0"); both must resolve to
 *      the same flat relays-cache entry. We strip explicitly at the call site
 *      (the adapter strips too, but explicitness keeps the contract obvious).
 *   3. Stream ID override precedence:
 *        (1) user-entered `relay_streamid_override` (highest)
 *        (2) resolved account `ingest_key` (subscription mode, from adapter)
 *        (3) manual-mode `srt_streamid` (from adapter)
 *
 * The adapter returns `{ addr, port, streamid }`; this layer maps it onto the
 * `{ srtlaAddr, srtlaPort, streamid }` shape `streaming.ts` hands to
 * `startStream`. Pure: the relays-cache snapshot is injected, never read from a
 * singleton here.
 */

import {
	parseNamespacedRelayId,
	type RelayProtocol,
	type RelaysCache,
} from "../../../helpers/config-schemas.ts";

import { getAdapter } from "./registry.ts";
import { RistUnavailableError } from "./types.ts";

/** Capability flags that gate which promoted protocols the resolver may route to. */
export interface ResolveEndpointOptions {
	/** Whether the engine advertises RIST capability (Task 19/20). */
	ristAvailable?: boolean;
}

/** Resolution input — the relay/manual selection plus the editable streamid. */
export interface StreamResolutionInput {
	/** Selected relay server id (flat or provider-namespaced). */
	relay_server?: string;
	/** Selected relay account id (flat or provider-namespaced). */
	relay_account?: string;
	/** Manual SRTLA address (used when no relay server is selected). */
	srtla_addr?: string;
	/** Manual SRTLA port (used when no relay server is selected). */
	srtla_port?: number;
	/** Manual stream id (used when no relay account is selected). */
	srt_streamid?: string;
	/** User-entered stream id override (highest precedence when non-empty). */
	relay_streamid_override?: string;
	/** Transport protocol; falls back to the caller fallback then "srtla". */
	relay_protocol?: RelayProtocol;
}

/** The endpoint shape `streaming.ts` forwards to `startStream`. */
export interface ResolvedStreamEndpoint {
	srtlaAddr: string;
	srtlaPort: number;
	streamid: string;
}

/** Strip a provider namespace (if present) to the flat cache lookup id. */
function flatRelayId(id: string | undefined): string | undefined {
	return id === undefined ? undefined : parseNamespacedRelayId(id).serverId;
}

/**
 * Resolve the concrete streaming endpoint for a relay/manual selection.
 *
 * @param input  Relay/manual selection + editable streamid override.
 * @param relays Relays-cache snapshot (`getRelays()`); `undefined` ⇒ manual.
 * @param fallbackProtocol Protocol to use when `input.relay_protocol` is unset
 *                         (typically the persisted `config.relay_protocol`).
 * @param options Capability flags; RIST is rejected unless `ristAvailable`.
 */
export function resolveStreamEndpoint(
	input: StreamResolutionInput,
	relays: RelaysCache | undefined,
	fallbackProtocol?: RelayProtocol,
	options?: ResolveEndpointOptions,
): ResolvedStreamEndpoint {
	const protocol = input.relay_protocol ?? fallbackProtocol ?? "srtla";

	if (protocol === "rist" && !options?.ristAvailable) {
		throw new RistUnavailableError();
	}

	// Strip the provider namespace before the flat relays-cache lookup. Flat ids
	// (no separator) pass through unchanged, preserving golden parity.
	const relay_server = flatRelayId(input.relay_server);
	const relay_account = flatRelayId(input.relay_account);
	const resolved = getAdapter(protocol).resolveEndpoint({
		...(relay_server !== undefined ? { relay_server } : {}),
		...(relay_account !== undefined ? { relay_account } : {}),
		...(input.srtla_addr !== undefined ? { srtla_addr: input.srtla_addr } : {}),
		...(input.srtla_port !== undefined ? { srtla_port: input.srtla_port } : {}),
		...(input.srt_streamid !== undefined
			? { srt_streamid: input.srt_streamid }
			: {}),
		...(relays !== undefined ? { relays } : {}),
	});

	// Stream ID precedence: user-entered override (non-empty) wins over the
	// adapter-resolved streamid (account ingest_key / manual srt_streamid).
	const override = input.relay_streamid_override;
	const streamid =
		typeof override === "string" && override.length > 0
			? override
			: resolved.streamid;

	// Map adapter output { addr, port } → { srtlaAddr, srtlaPort }.
	return {
		srtlaAddr: resolved.addr,
		srtlaPort: resolved.port,
		streamid,
	};
}
