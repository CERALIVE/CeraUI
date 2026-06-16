/*
	CeraUI - Mock Relay Fixtures
	Static RelaysCache with 3-5 multi-region servers and 2 accounts
*/

import type { RelaysCache } from "../../helpers/config-schemas.ts";
import { buildMockRelay } from "../fixture-factory.ts";

// ─── Stable server IDs for T5 (RTT generator) and T7 (rebroadcast) ──────────

export const MOCK_RELAY_SERVER_IDS = {
	EU_WEST: "relay-eu-west-1",
	US_EAST: "relay-us-east-1",
	ASIA_SE: "relay-asia-se-1",
	US_WEST: "relay-us-west-1",
	EU_CENTRAL: "relay-eu-central-1",
} as const;

// ─── Stable account IDs ────────────────────────────────────────────────────

export const MOCK_RELAY_ACCOUNT_IDS = {
	PRIMARY: "account-primary",
	SECONDARY: "account-secondary",
} as const;

/**
 * Get mock RelaysCache fixture
 * Returns a static cache with:
 * - 4 servers across distinct regions (EU-West, US-East, Asia-SE, US-West)
 * - Exactly one server with default: true (EU-West)
 * - 2 accounts (one normal, one disabled)
 * - Optional bcrp_key for BCRP protocol
 */
export function getMockRelaysCache(): RelaysCache {
	return {
		bcrp_key: "mock-bcrp-key-12345",
		servers: {
			[MOCK_RELAY_SERVER_IDS.EU_WEST]: buildMockRelay({
				name: "EU-West (Primary)",
				addr: "relay-eu-west.example.com",
				default: true,
				bcrp_port: "2002",
			}),
			[MOCK_RELAY_SERVER_IDS.US_EAST]: buildMockRelay({
				name: "US-East",
				addr: "relay-us-east.example.com",
			}),
			[MOCK_RELAY_SERVER_IDS.ASIA_SE]: buildMockRelay({
				name: "Asia-SE",
				addr: "relay-asia-se.example.com",
			}),
			[MOCK_RELAY_SERVER_IDS.US_WEST]: buildMockRelay({
				name: "US-West",
				addr: "relay-us-west.example.com",
			}),
		},
		accounts: {
			[MOCK_RELAY_ACCOUNT_IDS.PRIMARY]: {
				name: "Primary Account",
				ingest_key: "primary-ingest-key-abc123def456",
			},
			[MOCK_RELAY_ACCOUNT_IDS.SECONDARY]: {
				name: "Secondary Account",
				ingest_key: "secondary-ingest-key-xyz789uvw012",
				disabled: true,
			},
		},
	};
}

// ─── RTT Generator (T5) ─────────────────────────────────────────────────────
// Per-server RTT bands exercising thresholds: ≤RELAY_RTT_GREEN_MS 🟢, ≤RELAY_RTT_YELLOW_MS 🟡, >RELAY_RTT_YELLOW_MS 🔴

/**
 * Get mock RTT for a single relay server
 * Returns a time-varying value within a per-server band using Math.random()
 * Bands are assigned to exercise all threshold boundaries
 */
export function getMockRelayRtt(serverId: string): number {
	// EU-West: steady green (≤RELAY_RTT_GREEN_MS)
	if (serverId === MOCK_RELAY_SERVER_IDS.EU_WEST) {
		return 40 + Math.random() * 35; // 40-75ms
	}

	// US-East: oscillating green↔yellow (~70-120ms)
	if (serverId === MOCK_RELAY_SERVER_IDS.US_EAST) {
		return 70 + Math.random() * 55; // 70-125ms
	}

	// Asia-SE: yellow/red (>RELAY_RTT_YELLOW_MS occasionally, ~100-200ms)
	if (serverId === MOCK_RELAY_SERVER_IDS.ASIA_SE) {
		return 100 + Math.random() * 110; // 100-210ms
	}

	// US-West: oscillating yellow↔red (~120-180ms)
	if (serverId === MOCK_RELAY_SERVER_IDS.US_WEST) {
		return 120 + Math.random() * 70; // 120-190ms
	}

	// EU-Central (if present): steady yellow (≤RELAY_RTT_YELLOW_MS)
	if (serverId === MOCK_RELAY_SERVER_IDS.EU_CENTRAL) {
		return 90 + Math.random() * 55; // 90-145ms
	}

	// Unknown server: return a neutral value
	return 50 + Math.random() * 100;
}

/**
 * Get mock RTT for all relay servers
 * Returns a Record<serverId, rtt> keyed by fixture server IDs
 * Matches the signature of bcrpt.ts:getAllRelaysRtt()
 */
export function getAllMockRelaysRtt(): Record<string, number> {
	const rtt: Record<string, number> = {};

	// Populate RTT for all known server IDs
	for (const serverId of Object.values(MOCK_RELAY_SERVER_IDS)) {
		rtt[serverId] = getMockRelayRtt(serverId);
	}

	return rtt;
}
