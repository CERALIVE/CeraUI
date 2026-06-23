/*
 * T9 — relay servers carry provider metadata (CeraLive/BELABOX).
 *
 * Locks two boundaries:
 *   1. the runtime relay-cache schema round-trips `provider:{id,name,kind}`, and
 *   2. the mock catalog seeds at least one CeraLive and one BELABOX server, with
 *      every server's `provider.kind` in {ceralive, belabox} (T10/T12 depend on
 *      this multi-provider mock data being present).
 *
 * Also asserts the real relay-catalog push (`validateRemoteRelays`) tags every
 * validated server/account with the active provider's metadata.
 */
import { describe, expect, it } from "bun:test";
import {
	RELAY_PROVIDER_KINDS,
	relayProviderMetaForId,
} from "@ceraui/rpc/schemas";

import { relaysCacheSchema } from "../helpers/config-schemas.ts";
import { getMockRelaysCache } from "../mocks/providers/relays.ts";
import { validateRemoteRelays } from "../modules/remote/remote-relays.ts";

const TAGGABLE_KINDS = new Set(["ceralive", "belabox"]);

describe("relay provider metadata (T9)", () => {
	it("round-trips provider metadata through the runtime relay-cache schema", () => {
		const parsed = relaysCacheSchema.parse(getMockRelaysCache());

		for (const server of Object.values(parsed.servers)) {
			expect(server.provider).toBeDefined();
			expect(RELAY_PROVIDER_KINDS).toContain(server.provider?.kind);
		}
	});

	it("seeds at least one CeraLive and one BELABOX mock server", () => {
		const servers = Object.values(getMockRelaysCache().servers);
		const kinds = servers.map((server) => server.provider?.kind);

		expect(kinds).toContain("ceralive");
		expect(kinds).toContain("belabox");
	});

	it("tags every mock server with provider.kind in {ceralive, belabox}", () => {
		const servers = Object.values(getMockRelaysCache().servers);
		expect(servers.length).toBeGreaterThanOrEqual(2);

		for (const server of servers) {
			const kind = server.provider?.kind;
			expect(kind).toBeDefined();
			expect(TAGGABLE_KINDS.has(kind as string)).toBe(true);
		}
	});

	it("exposes at least two distinct providers across the mock catalog", () => {
		const servers = Object.values(getMockRelaysCache().servers);
		const providerIds = new Set(servers.map((s) => s.provider?.id));
		expect(providerIds.size).toBeGreaterThanOrEqual(2);
	});

	it("tags a real relay-catalog push with the active provider metadata", () => {
		const belabox = relayProviderMetaForId("belabox");
		const validated = validateRemoteRelays(
			{
				servers: {
					"0": {
						type: "srtla",
						name: "Pushed Server",
						addr: "relay.example.com",
						port: 2001,
						default: true,
					},
				},
				accounts: {
					acc: { name: "Pushed Account", ingest_key: "key-123" },
				},
			},
			belabox,
		);

		expect(validated).toBeDefined();
		expect(validated?.servers["0"]?.provider).toEqual(belabox);
		expect(validated?.accounts.acc?.provider).toEqual(belabox);
	});

	it("leaves provider absent on an untagged push (legacy-safe)", () => {
		const validated = validateRemoteRelays({
			servers: {
				"0": {
					type: "srtla",
					name: "Legacy Server",
					addr: "relay.example.com",
					port: 2001,
				},
			},
			accounts: {},
		});

		expect(validated?.servers["0"]?.provider).toBeUndefined();
	});
});
