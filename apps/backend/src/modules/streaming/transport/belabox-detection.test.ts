import { describe, expect, it } from "bun:test";

import { validatePortNo } from "../../../helpers/number.ts";

import belaboxFeed from "./belabox-feed.fixture.json";
import {
	belaboxDetectionMethod,
	belaboxProviderMeta,
	normalizeBelaboxRelays,
} from "./belabox-detection.ts";
import { getDetectionMethod } from "./registry.ts";
import type { RawRelayFeed } from "./types.ts";

// The untrusted feed is cast through `unknown`: RawRelayFeed deliberately types
// every field as `unknown` (it models an over-the-wire payload).
const feed = belaboxFeed as unknown as RawRelayFeed;

const PROVIDER = { id: "belabox", name: "BELABOX Cloud", kind: "belabox" };

// =============================================================================
// Historical oracle — verbatim port of remote-relays.ts:validateRemoteRelays
// (stable since bf74852, ported at c573010). The belabox detection method must
// select/filter/preserve the exact same catalog. Kept inline + side-effect free
// so the test fails loudly if the new normalizer ever diverges from the loader.
// =============================================================================

interface HistServer {
	type: string;
	name: string;
	addr: string;
	port: number;
	default?: true;
	bcrp_port?: string;
}
interface HistAccount {
	name: string;
	ingest_key: string;
	disabled?: true;
}
interface HistCache {
	servers: Record<string, HistServer>;
	accounts: Record<string, HistAccount>;
}

function historicalValidateRelays(input: RawRelayFeed): HistCache | undefined {
	const out: HistCache = { servers: {}, accounts: {} };

	const servers = input.servers ?? {};
	for (const id of Object.keys(servers)) {
		const r = servers[id];
		if (!r) continue;
		if (
			r.type !== "srtla" ||
			typeof r.name !== "string" ||
			typeof r.addr !== "string"
		)
			continue;
		if (r.default && r.default !== true) continue;
		const port = validatePortNo(typeof r.port === "number" ? r.port : undefined);
		if (!port) continue;
		const server: HistServer = {
			type: "srtla",
			name: r.name,
			addr: r.addr,
			port,
		};
		if (typeof r.bcrp_port === "string" && r.bcrp_port)
			server.bcrp_port = r.bcrp_port;
		if (r.default) server.default = true;
		out.servers[id] = server;
	}

	const accounts = input.accounts ?? {};
	for (const id of Object.keys(accounts)) {
		const a = accounts[id];
		if (!a || typeof a.name !== "string" || typeof a.ingest_key !== "string")
			continue;
		const account: HistAccount = { name: a.name, ingest_key: a.ingest_key };
		if (a.disabled) account.disabled = true;
		out.accounts[id] = account;
	}

	if (Object.keys(out.servers).length < 1) return undefined;
	return out;
}

// =============================================================================
// Golden output
// =============================================================================

describe("belabox detection — golden normalized catalog", () => {
	it("normalizes the BELABOX feed into a provider-tagged catalog", () => {
		expect(normalizeBelaboxRelays(feed)).toEqual({
			servers: {
				"0": {
					name: "Frankfurt",
					addr: "fra.belabox.net",
					port: 5000,
					protocol: "srtla",
					provider: PROVIDER,
					bcrp_port: "5001",
					default: true,
				},
				"1": {
					name: "New York",
					addr: "nyc.belabox.net",
					port: 6000,
					protocol: "srtla",
					provider: PROVIDER,
				},
			},
			accounts: {
				"10": {
					name: "Primary",
					ingest_key: "ingest-primary-abc",
					provider: PROVIDER,
				},
				"11": {
					name: "Secondary",
					ingest_key: "ingest-secondary-xyz",
					provider: PROVIDER,
					disabled: true,
				},
			},
		});
	});

	it("tags every server and account with BELABOX provider metadata", () => {
		const out = normalizeBelaboxRelays(feed);
		expect(out).toBeDefined();
		if (!out) return;
		for (const server of Object.values(out.servers)) {
			expect(server.provider).toEqual(PROVIDER);
			expect(server.protocol).toBe("srtla");
		}
		for (const account of Object.values(out.accounts)) {
			expect(account.provider).toEqual(PROVIDER);
		}
	});

	it("sources provider metadata from the cloud-provider schema", () => {
		expect(belaboxProviderMeta()).toEqual(PROVIDER);
	});
});

// =============================================================================
// Historical-behaviour parity
// =============================================================================

describe("belabox detection — historical loader parity", () => {
	it("selects the same catalog as the historical validateRemoteRelays", () => {
		const normalized = normalizeBelaboxRelays(feed);
		const historical = historicalValidateRelays(feed);
		expect(normalized).toBeDefined();
		expect(historical).toBeDefined();
		if (!normalized || !historical) return;

		const normCore = {
			servers: Object.fromEntries(
				Object.entries(normalized.servers).map(([id, s]) => [
					id,
					{
						name: s.name,
						addr: s.addr,
						port: s.port,
						default: s.default,
						bcrp_port: s.bcrp_port,
					},
				]),
			),
			accounts: Object.fromEntries(
				Object.entries(normalized.accounts).map(([id, a]) => [
					id,
					{ name: a.name, ingest_key: a.ingest_key, disabled: a.disabled },
				]),
			),
		};
		const histCore = {
			servers: Object.fromEntries(
				Object.entries(historical.servers).map(([id, s]) => [
					id,
					{
						name: s.name,
						addr: s.addr,
						port: s.port,
						default: s.default,
						bcrp_port: s.bcrp_port,
					},
				]),
			),
			accounts: Object.fromEntries(
				Object.entries(historical.accounts).map(([id, a]) => [
					id,
					{ name: a.name, ingest_key: a.ingest_key, disabled: a.disabled },
				]),
			),
		};

		expect(normCore).toEqual(histCore);
	});

	it("drops non-srtla servers (type !== 'srtla')", () => {
		const out = normalizeBelaboxRelays(feed);
		expect(out?.servers["srt-only"]).toBeUndefined();
	});

	it("drops servers with an out-of-range or zero port", () => {
		const out = normalizeBelaboxRelays(feed);
		expect(out?.servers["bad-port-high"]).toBeUndefined();
		expect(out?.servers["bad-port-zero"]).toBeUndefined();
	});

	it("drops accounts missing an ingest_key", () => {
		const out = normalizeBelaboxRelays(feed);
		expect(out?.accounts["12"]).toBeUndefined();
	});

	it("preserves the default flag and bcrp_port on the default server", () => {
		const out = normalizeBelaboxRelays(feed);
		expect(out?.servers["0"]?.default).toBe(true);
		expect(out?.servers["0"]?.bcrp_port).toBe("5001");
	});

	it("preserves the disabled flag on a disabled account", () => {
		const out = normalizeBelaboxRelays(feed);
		expect(out?.accounts["11"]?.disabled).toBe(true);
	});

	it("rejects a feed with no usable server (returns undefined)", () => {
		expect(normalizeBelaboxRelays({ servers: {}, accounts: {} })).toBeUndefined();
		expect(
			normalizeBelaboxRelays({
				servers: {
					x: { type: "srt", name: "n", addr: "a", port: 1234 },
				},
			}),
		).toBeUndefined();
	});
});

// =============================================================================
// Registry integration
// =============================================================================

describe("belabox detection — registry integration", () => {
	it("is registered under detectionMethod 'belabox'", () => {
		const method = getDetectionMethod("belabox");
		expect(method).toBe(belaboxDetectionMethod);
		expect(method?.method).toBe("belabox");
		expect(method?.providerKind).toBe("belabox");
	});

	it("normalizes through the registry-resolved method identically", () => {
		const method = getDetectionMethod("belabox");
		expect(method?.normalize?.(feed)).toEqual(normalizeBelaboxRelays(feed));
	});
});
