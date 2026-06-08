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

/**
 * BELABOX detection method (`detectionMethod="belabox"`).
 *
 * Normalizes a BELABOX-compatible relay feed into a provider-tagged catalog. It
 * is a faithful re-implementation of the historical loader `validateRemoteRelays`
 * (remote-relays.ts, stable since commit bf74852 / ported at c573010): for the
 * same feed it selects, filters and preserves the exact same servers/accounts,
 * then tags each with BELABOX provider metadata and the `srtla` protocol.
 *
 * The catalog is the only output. The BCRP key is intentionally NOT read or
 * surfaced — it is an orthogonal transport secret, not part of relay detection.
 */

import { getProviderById, type RelayProviderMeta } from "@ceraui/rpc/schemas";

import { validatePortNo } from "../../../helpers/number.ts";

import type {
	DetectionContext,
	DetectionMethod,
	NormalizedRelayAccount,
	NormalizedRelayConfig,
	NormalizedRelayServer,
	RawRelayFeed,
} from "./types.ts";

const BELABOX_PROVIDER_KIND = "belabox" as const;

/** Provider metadata for the BELABOX cloud feed (sourced from the schema). */
export function belaboxProviderMeta(): RelayProviderMeta {
	const endpoint = getProviderById("belabox");
	return {
		id: endpoint?.id ?? "belabox",
		name: endpoint?.name ?? "BELABOX Cloud",
		kind: BELABOX_PROVIDER_KIND,
	};
}

export function normalizeBelaboxRelays(
	feed: RawRelayFeed,
	ctx?: Partial<DetectionContext>,
): NormalizedRelayConfig | undefined {
	const provider = ctx?.provider ?? belaboxProviderMeta();
	const out: NormalizedRelayConfig = { servers: {}, accounts: {} };

	const servers = feed.servers ?? {};
	for (const id of Object.keys(servers)) {
		const r = servers[id];
		if (!r) continue;

		// BELABOX feed contract: only SRTLA servers with a name + address.
		if (
			r.type !== "srtla" ||
			typeof r.name !== "string" ||
			typeof r.addr !== "string"
		)
			continue;
		// `default`, when present, must be exactly `true` (else drop the server).
		if (r.default && r.default !== true) continue;

		const port = validatePortNo(
			typeof r.port === "number" ? r.port : undefined,
		);
		if (!port) continue;

		const server: NormalizedRelayServer = {
			name: r.name,
			addr: r.addr,
			port,
			protocol: "srtla",
			provider,
		};
		if (typeof r.bcrp_port === "string" && r.bcrp_port)
			server.bcrp_port = r.bcrp_port;
		if (r.default) server.default = true;
		out.servers[id] = server;
	}

	const accounts = feed.accounts ?? {};
	for (const id of Object.keys(accounts)) {
		const a = accounts[id];
		if (!a || typeof a.name !== "string" || typeof a.ingest_key !== "string")
			continue;

		const account: NormalizedRelayAccount = {
			name: a.name,
			ingest_key: a.ingest_key,
			provider,
		};
		if (a.disabled) account.disabled = true;
		out.accounts[id] = account;
	}

	// Historical rejection: a feed with no usable server yields nothing.
	if (Object.keys(out.servers).length < 1) return undefined;

	return out;
}

export const belaboxDetectionMethod: DetectionMethod = {
	method: "belabox",
	providerKind: BELABOX_PROVIDER_KIND,
	describe: () => "BELABOX-compatible relay feed",
	normalize: normalizeBelaboxRelays,
};
