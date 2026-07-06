// @vitest-environment jsdom
import type { ConfigMessage, RelayMessage } from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it } from "vitest";

import {
	ENDPOINT_FINGERPRINT_KEYS,
	fingerprintForValidation,
	getDestinationValidated,
	getDestinationVerdict,
	recordValidation,
	resetDestinationValidation,
	resolveValidationEndpoint,
} from "./destination-validation.svelte";
import {
	buildManagedSlotConfig,
	buildServerSetConfig,
	type ManagedIngestAccount,
	type ServerSetDerived,
	type ServerSetDraft,
} from "./receiver-experience";

// ── Fixtures ────────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<ConfigMessage> = {}): ConfigMessage {
	return {
		relay_server: "fra",
		relay_account: "acct-1",
		relay_streamid_override: "override-1",
		relay_protocol: "srtla",
		srtla_addr: "1.2.3.4",
		srtla_port: 6000,
		srt_streamid: "sid-1",
		selected_ingest_endpoint: "slot-1",
		srt_latency: 2000,
		...overrides,
	} as ConfigMessage;
}

function relaysWith(addr: string, port: number): RelayMessage {
	return {
		accounts: {},
		servers: {
			fra: { name: "Frankfurt", addr, port, protocol: "srtla" },
		},
	} as RelayMessage;
}

function slot(
	overrides: Partial<ManagedIngestAccount> = {},
): ManagedIngestAccount {
	return {
		endpointId: "slot-1",
		host: "slot.example",
		port: 8000,
		protocol: "srtla",
		key: "slot-key",
		label: "Slot 1",
		...overrides,
	};
}

// ── Self-consistency: the constant tracks the two save-payload builders ────────

describe("ENDPOINT_FINGERPRINT_KEYS — self-consistency", () => {
	// Drive both builders to force EVERY emittable key, then prove the constant is
	// exactly {emittable keys} \ {srt_latency}. Guards drift when receiver-
	// experience changes the persisted field set.
	function allEmittedKeys(): Set<string> {
		const draft: ServerSetDraft = {
			latency: 2000,
			protocol: "srtla",
			addr: "1.2.3.4",
			portStr: "6000",
			streamId: "sid",
			relayStreamId: "override",
			relayServer: "fra",
			relayAccount: "acct",
		};
		const custom = buildServerSetConfig(draft, {
			destination: "custom",
		} satisfies ServerSetDerived);
		const managed = buildServerSetConfig(draft, {
			destination: "managed",
		} satisfies ServerSetDerived);
		const slotCfg = buildManagedSlotConfig(slot(), 2000);
		return new Set([
			...Object.keys(custom),
			...Object.keys(managed),
			...Object.keys(slotCfg),
		]);
	}

	it("every member is a key the two builders can emit", () => {
		const emitted = allEmittedKeys();
		for (const key of ENDPOINT_FINGERPRINT_KEYS) {
			expect(emitted.has(key), `builders emit "${key}"`).toBe(true);
		}
	});

	it("excludes ONLY srt_latency (which the builders still emit)", () => {
		const emitted = allEmittedKeys();
		expect(emitted.has("srt_latency")).toBe(true);
		expect(
			(ENDPOINT_FINGERPRINT_KEYS as readonly string[]).includes("srt_latency"),
		).toBe(false);
		// The constant is precisely the emittable set minus srt_latency.
		const expected = [...emitted].filter((k) => k !== "srt_latency").sort();
		expect([...ENDPOINT_FINGERPRINT_KEYS].sort()).toEqual(expected);
	});
});

// ── Fingerprint invalidation — one case per member (incl. srtla_port) ──────────

describe("fingerprintForValidation — invalidation per key", () => {
	const relays = relaysWith("relay.example", 7000);
	// Empty managedAccounts so the slot tier is skipped → the relay_server tier
	// resolves the endpoint; each key still lives in the config-subset half.
	const accounts: ManagedIngestAccount[] = [];

	const mutations: Record<
		(typeof ENDPOINT_FINGERPRINT_KEYS)[number],
		Partial<ConfigMessage>
	> = {
		relay_server: { relay_server: "ams" },
		relay_account: { relay_account: "acct-2" },
		relay_streamid_override: { relay_streamid_override: "override-2" },
		relay_protocol: { relay_protocol: "rist" },
		srtla_addr: { srtla_addr: "9.9.9.9" },
		srtla_port: { srtla_port: 6001 },
		srt_streamid: { srt_streamid: "sid-2" },
		selected_ingest_endpoint: { selected_ingest_endpoint: "slot-2" },
	};

	for (const key of ENDPOINT_FINGERPRINT_KEYS) {
		it(`changing ${key} changes the fingerprint`, () => {
			const before = fingerprintForValidation(baseConfig(), relays, accounts);
			const after = fingerprintForValidation(
				baseConfig(mutations[key]),
				relays,
				accounts,
			);
			expect(after).not.toBe(before);
		});
	}
});

// ── Catalog drift — same relay_server id, different resolved addr/port ─────────

describe("fingerprintForValidation — catalog drift", () => {
	const config = baseConfig({ selected_ingest_endpoint: undefined });
	const accounts: ManagedIngestAccount[] = [];

	it("a changed catalog addr for the same relay_server id re-keys the fingerprint", () => {
		const before = fingerprintForValidation(
			config,
			relaysWith("a.example", 7000),
			accounts,
		);
		const after = fingerprintForValidation(
			config,
			relaysWith("b.example", 7000),
			accounts,
		);
		expect(after).not.toBe(before);
	});

	it("a changed catalog port for the same relay_server id re-keys the fingerprint", () => {
		const before = fingerprintForValidation(
			config,
			relaysWith("a.example", 7000),
			accounts,
		);
		const after = fingerprintForValidation(
			config,
			relaysWith("a.example", 7001),
			accounts,
		);
		expect(after).not.toBe(before);
	});

	it("the resolved endpoint follows the catalog, not the config addr", () => {
		const endpoint = resolveValidationEndpoint(
			config,
			relaysWith("catalog.example", 7000),
			accounts,
		);
		expect(endpoint).toEqual({
			addr: "catalog.example",
			port: 7000,
			streamid: "override-1",
			protocol: "srtla",
		});
	});
});

// ── srt_latency is NOT an endpoint field ──────────────────────────────────────

describe("fingerprintForValidation — srt_latency is non-invalidating", () => {
	const relays = relaysWith("relay.example", 7000);
	const accounts: ManagedIngestAccount[] = [];

	it("changing srt_latency leaves the fingerprint unchanged", () => {
		const before = fingerprintForValidation(
			baseConfig({ srt_latency: 2000 }),
			relays,
			accounts,
		);
		const after = fingerprintForValidation(
			baseConfig({ srt_latency: 4500 }),
			relays,
			accounts,
		);
		expect(after).toBe(before);
	});
});

// ── Endpoint resolution priority (slot → relay_server → custom) ────────────────

describe("resolveValidationEndpoint — priority", () => {
	it("prefers the resolved managed slot from managedAccounts", () => {
		const endpoint = resolveValidationEndpoint(
			baseConfig(),
			relaysWith("relay.example", 7000),
			[slot({ host: "slot.example", port: 8000, key: "slot-key" })],
		);
		expect(endpoint).toEqual({
			addr: "slot.example",
			port: 8000,
			streamid: "slot-key",
			protocol: "srtla",
		});
	});

	it("falls back to a custom endpoint when no server/slot is present", () => {
		const endpoint = resolveValidationEndpoint(
			baseConfig({
				relay_server: undefined,
				selected_ingest_endpoint: undefined,
			}),
			undefined,
			[],
		);
		expect(endpoint).toEqual({
			addr: "1.2.3.4",
			port: 6000,
			streamid: "sid-1",
			protocol: "srtla",
		});
	});

	it("returns undefined for a managed id absent from a still-loading catalog", () => {
		expect(
			resolveValidationEndpoint(
				baseConfig({ selected_ingest_endpoint: undefined }),
				undefined,
				[],
			),
		).toBeUndefined();
	});
});

// ── Verdict store: record + match (validated only on a fingerprint match) ──────

describe("recordValidation + getDestinationValidated", () => {
	afterEach(() => resetDestinationValidation());

	const relays = relaysWith("relay.example", 7000);
	const accounts: ManagedIngestAccount[] = [];

	it("is false before any validation is recorded", () => {
		expect(getDestinationValidated(baseConfig(), relays, accounts)).toBe(false);
	});

	it("is true only for the exact fingerprint that passed", () => {
		const config = baseConfig();
		recordValidation(fingerprintForValidation(config, relays, accounts), true);
		expect(getDestinationValidated(config, relays, accounts)).toBe(true);
		expect(getDestinationVerdict()?.verdict).toBe("validated");
	});

	it("resets to false after an endpoint edit (fingerprint no longer matches)", () => {
		const config = baseConfig();
		recordValidation(fingerprintForValidation(config, relays, accounts), true);
		const edited = baseConfig({ srtla_addr: "5.6.7.8" });
		expect(getDestinationValidated(edited, relays, accounts)).toBe(false);
	});

	it("STAYS true after only srt_latency changes", () => {
		const config = baseConfig({ srt_latency: 2000 });
		recordValidation(fingerprintForValidation(config, relays, accounts), true);
		const retuned = baseConfig({ srt_latency: 4500 });
		expect(getDestinationValidated(retuned, relays, accounts)).toBe(true);
	});

	it("resets to false after catalog drift under the same relay_server id", () => {
		const config = baseConfig({ selected_ingest_endpoint: undefined });
		recordValidation(
			fingerprintForValidation(config, relaysWith("a.example", 7000), accounts),
			true,
		);
		expect(
			getDestinationValidated(config, relaysWith("a.example", 7000), accounts),
		).toBe(true);
		expect(
			getDestinationValidated(config, relaysWith("b.example", 7000), accounts),
		).toBe(false);
	});

	it("a failed verdict never reports validated", () => {
		const config = baseConfig();
		recordValidation(fingerprintForValidation(config, relays, accounts), false);
		expect(getDestinationValidated(config, relays, accounts)).toBe(false);
		expect(getDestinationVerdict()?.verdict).toBe("failed");
	});
});
