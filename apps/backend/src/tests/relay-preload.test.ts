/*
 * Task 9 — subscription-key auto-preload of the active relay server endpoint
 * and editable stream-id, plus single-active provider-switch clearing.
 *
 * Exercises the pure preload core (computeSubscriptionPreload) so the four
 * behaviours are verified without the WS lifecycle / disk-cache module state:
 *   (a) catalog pushed  -> default server endpoint preloads (namespaced)
 *   (b) account selected -> editable relay_streamid_override filled from ingest_key
 *   (c) provider switch  -> prior provider's selection cleared (single-active)
 *   (d) namespaced ids   -> resolve back to the correct provider + server/account
 */
import { describe, expect, it } from "bun:test";

import {
	DEFAULT_RELAY_PROVIDER_ID,
	parseNamespacedRelayId,
	type RuntimeConfig,
} from "../helpers/config-schemas.ts";
import {
	getMockRelaysCache,
	MOCK_RELAY_ACCOUNT_IDS,
	MOCK_RELAY_SERVER_IDS,
} from "../mocks/providers/relays.ts";
import { computeSubscriptionPreload } from "../modules/remote/remote-relays.ts";

describe("subscription relay auto-preload (Task 9)", () => {
	it("(a) catalog push preloads the default server endpoint as a namespaced id", () => {
		const relays = getMockRelaysCache();
		const config: RuntimeConfig = { remote_key: "k", remote_provider: "ceralive" };

		const modified = computeSubscriptionPreload(
			config,
			relays,
			DEFAULT_RELAY_PROVIDER_ID,
		);

		expect(modified).toBe(true);
		expect(config.relay_server).toBe(
			`${DEFAULT_RELAY_PROVIDER_ID}:${MOCK_RELAY_SERVER_IDS.EU_WEST}`,
		);
		expect(config.detectionMethod).toBe("subscription");

		const { serverId } = parseNamespacedRelayId(config.relay_server as string);
		const server = relays.servers[serverId];
		expect(server?.addr).toBe("relay-eu-west.example.com");
		expect(server?.port).toBe(2001);
	});

	it("falls back to the first server when none is marked default", () => {
		const relays = getMockRelaysCache();
		for (const id of Object.keys(relays.servers)) {
			delete relays.servers[id]?.default;
		}
		const firstId = Object.keys(relays.servers)[0] as string;
		const config: RuntimeConfig = { remote_key: "k" };

		computeSubscriptionPreload(config, relays, DEFAULT_RELAY_PROVIDER_ID);

		expect(config.relay_server).toBe(`${DEFAULT_RELAY_PROVIDER_ID}:${firstId}`);
	});

	it("(b) account selection fills the editable streamid override from ingest_key", () => {
		const relays = getMockRelaysCache();
		const config: RuntimeConfig = { remote_key: "k", remote_provider: "ceralive" };

		computeSubscriptionPreload(config, relays, DEFAULT_RELAY_PROVIDER_ID);

		expect(config.relay_account).toBe(
			`${DEFAULT_RELAY_PROVIDER_ID}:${MOCK_RELAY_ACCOUNT_IDS.PRIMARY}`,
		);
		expect(config.relay_streamid_override).toBe(
			"primary-ingest-key-abc123def456",
		);
	});

	it("skips disabled accounts and prefers the first enabled one", () => {
		const relays = getMockRelaysCache();
		delete relays.accounts[MOCK_RELAY_ACCOUNT_IDS.PRIMARY];
		const config: RuntimeConfig = { remote_key: "k" };

		computeSubscriptionPreload(config, relays, DEFAULT_RELAY_PROVIDER_ID);

		expect(config.relay_account).toBeUndefined();
		expect(config.relay_streamid_override).toBeUndefined();
	});

	it("(c) provider switch clears the prior provider's selection (single-active)", () => {
		const relays = getMockRelaysCache();
		const config: RuntimeConfig = {
			remote_key: "k",
			remote_provider: "ceralive",
			relay_server: `belabox:${MOCK_RELAY_SERVER_IDS.US_EAST}`,
			relay_account: `belabox:${MOCK_RELAY_ACCOUNT_IDS.SECONDARY}`,
			relay_streamid_override: "stale-belabox-key",
		};

		const modified = computeSubscriptionPreload(
			config,
			relays,
			DEFAULT_RELAY_PROVIDER_ID,
		);

		expect(modified).toBe(true);
		expect(config.relay_server).toBe(
			`${DEFAULT_RELAY_PROVIDER_ID}:${MOCK_RELAY_SERVER_IDS.EU_WEST}`,
		);
		expect(config.relay_account).toBe(
			`${DEFAULT_RELAY_PROVIDER_ID}:${MOCK_RELAY_ACCOUNT_IDS.PRIMARY}`,
		);
		expect(config.relay_streamid_override).toBe(
			"primary-ingest-key-abc123def456",
		);
		expect(config.detectionMethod).toBe("subscription");
	});

	it("(d) stored namespaced ids resolve back to the correct provider", () => {
		const relays = getMockRelaysCache();
		const config: RuntimeConfig = { remote_key: "k", remote_provider: "belabox" };

		computeSubscriptionPreload(config, relays, "belabox");

		const serverParts = parseNamespacedRelayId(config.relay_server as string);
		const accountParts = parseNamespacedRelayId(config.relay_account as string);

		expect(serverParts.providerId).toBe("belabox");
		expect(accountParts.providerId).toBe("belabox");
		expect(relays.servers[serverParts.serverId]).toBeDefined();
		expect(relays.accounts[accountParts.serverId]).toBeDefined();
	});

	it("is idempotent: a second pass with the same provider makes no changes", () => {
		const relays = getMockRelaysCache();
		const config: RuntimeConfig = { remote_key: "k", remote_provider: "ceralive" };

		const first = computeSubscriptionPreload(
			config,
			relays,
			DEFAULT_RELAY_PROVIDER_ID,
		);
		const second = computeSubscriptionPreload(
			config,
			relays,
			DEFAULT_RELAY_PROVIDER_ID,
		);

		expect(first).toBe(true);
		expect(second).toBe(false);
	});
});
