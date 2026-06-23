// @vitest-environment jsdom
import type { RelayServer, StreamingConfigInput } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	autoSelectIngestSlot,
	autoSelectManagedRelay,
	autoSelectManagedTransport,
	buildManagedSlotConfig,
	buildServerSetConfig,
	buildServerSummary,
	countRelayServersForProvider,
	type Destination,
	deriveDestination,
	deriveServerReadiness,
	findActiveSlot,
	groupRelayServersByProvider,
	kindBadgeLabelKey,
	type ManagedIngestAccount,
	managedSlotLabel,
	resolveReceiverKind,
	type ServerSetDerived,
	type ServerSetDraft,
	type ServerSummaryLabels,
} from "./receiver-experience";

function slot(
	overrides: Partial<ManagedIngestAccount> = {},
): ManagedIngestAccount {
	return {
		endpointId: "ep-1",
		host: "ingest1.example",
		port: 5000,
		protocol: "srtla",
		key: "publish/abc",
		label: "Studio A",
		...overrides,
	};
}

function relayServer(overrides: Partial<RelayServer> = {}): RelayServer {
	return {
		name: "Frankfurt",
		protocol: "srtla",
		addr: "fra.relay.example",
		port: 5000,
		...overrides,
	};
}

/** A complete draft; each test overrides only the fields its branch reads. */
function draft(overrides: Partial<ServerSetDraft> = {}): ServerSetDraft {
	return {
		latency: 2000,
		protocol: "srtla",
		addr: "custom.example",
		portStr: "5000",
		streamId: "publish/abc",
		overrideAddr: "override.example",
		overridePortStr: "6000",
		relayStreamId: "stream-id",
		relayServer: "fra",
		relayAccount: "acct-1",
		...overrides,
	};
}

const CUSTOM: ServerSetDerived = {
	destination: "custom",
	relayOverride: false,
};
const MANAGED: ServerSetDerived = {
	destination: "managed",
	relayOverride: false,
};
const OVERRIDE: ServerSetDerived = {
	destination: "managed",
	relayOverride: true,
};

describe("deriveDestination", () => {
	it("maps a non-empty relay_server to managed", () => {
		expect(deriveDestination({ relay_server: "fra" })).toBe("managed");
	});

	it("maps an absent relay_server to custom", () => {
		expect(deriveDestination({})).toBe("custom");
		expect(deriveDestination(undefined)).toBe("custom");
	});

	it("maps an empty relay_server to custom", () => {
		expect(deriveDestination({ relay_server: "" })).toBe("custom");
	});
});

describe("resolveReceiverKind truth table", () => {
	const cases: Array<{
		name: string;
		input: Parameters<typeof resolveReceiverKind>[0];
		expected: ReturnType<typeof resolveReceiverKind>;
	}> = [
		{
			name: "srtla managed → srtla_relay",
			input: {
				protocol: "srtla",
				destination: "managed",
				server: relayServer(),
			},
			expected: "srtla_relay",
		},
		{
			name: "srtla custom → srtla_custom",
			input: { protocol: "srtla", destination: "custom" },
			expected: "srtla_custom",
		},
		{
			name: "managed RIST → rist_relay",
			input: {
				protocol: "rist",
				destination: "managed",
				server: relayServer({ protocol: "rist" }),
			},
			expected: "rist_relay",
		},
		{
			name: "rist custom → rist_custom",
			input: { protocol: "rist", destination: "custom" },
			expected: "rist_custom",
		},
		{
			name: "srt custom → srt_custom (no managed variant)",
			input: { protocol: "srt", destination: "custom" },
			expected: "srt_custom",
		},
		{
			name: "override reload (no relay_server) → srtla_custom",
			input: { protocol: "srtla", destination: "custom" },
			expected: "srtla_custom",
		},
		{
			name: "legacy protocol undefined → srtla_custom",
			input: { protocol: undefined, destination: "custom" },
			expected: "srtla_custom",
		},
	];

	for (const { name, input, expected } of cases) {
		it(name, () => {
			expect(resolveReceiverKind(input)).toBe(expected);
		});
	}

	it("constrains the managed kind to a server's advertised transports", () => {
		// Requested srtla, but the server only advertises rist → rist_relay.
		const server = relayServer({ protocol: "rist", protocols: ["rist"] });
		expect(
			resolveReceiverKind({
				protocol: "srtla",
				destination: "managed",
				server,
			}),
		).toBe("rist_relay");
	});

	it("honours the requested protocol when the server advertises it", () => {
		const server = relayServer({ protocols: ["srtla", "rist"] });
		expect(
			resolveReceiverKind({ protocol: "rist", destination: "managed", server }),
		).toBe("rist_relay");
		expect(
			resolveReceiverKind({
				protocol: "srtla",
				destination: "managed",
				server,
			}),
		).toBe("srtla_relay");
	});
});

describe("kindBadgeLabelKey", () => {
	it("maps each receiver kind to its T2 i18n key", () => {
		expect(kindBadgeLabelKey("srtla_relay")).toBe(
			"live.server.kind.srtlaRelay",
		);
		expect(kindBadgeLabelKey("srtla_custom")).toBe(
			"live.server.kind.srtlaCustom",
		);
		expect(kindBadgeLabelKey("rist_relay")).toBe("live.server.kind.ristRelay");
		expect(kindBadgeLabelKey("rist_custom")).toBe(
			"live.server.kind.ristCustom",
		);
		expect(kindBadgeLabelKey("srt_custom")).toBe("live.server.kind.srtCustom");
	});
});

describe("deriveServerReadiness — SRTLA-only bonding claim (T13)", () => {
	it("SRTLA streaming with multiple links → bonded across N", () => {
		expect(deriveServerReadiness("srtla_custom", 3)).toEqual({
			variant: "bonded",
			count: 3,
		});
		expect(deriveServerReadiness("srtla_relay", 2)).toEqual({
			variant: "bonded",
			count: 2,
		});
	});

	it("SRTLA streaming with a single active link → honest single link", () => {
		expect(deriveServerReadiness("srtla_custom", 1)).toEqual({
			variant: "single",
		});
	});

	it("SRTLA idle (linkTelemetry === null) → label only, no count", () => {
		expect(deriveServerReadiness("srtla_custom", null)).toEqual({
			variant: "idle",
		});
		expect(deriveServerReadiness("srtla_relay", null)).toEqual({
			variant: "idle",
		});
		// 0 links is not a count worth asserting either — also label-only.
		expect(deriveServerReadiness("srtla_custom", 0)).toEqual({
			variant: "idle",
		});
	});

	it("non-SRTLA kinds never assert bonding (rist/srt → fixed single link)", () => {
		expect(deriveServerReadiness("rist_relay", 3)).toEqual({
			variant: "fixed",
		});
		expect(deriveServerReadiness("rist_custom", null)).toEqual({
			variant: "fixed",
		});
		expect(deriveServerReadiness("srt_custom", 5)).toEqual({
			variant: "fixed",
		});
	});
});

describe("buildServerSetConfig — byte-identical to today's handleSave branches", () => {
	it("manual (custom) emits exactly the manual field set", () => {
		const result = buildServerSetConfig(draft(), CUSTOM);
		// Mirrors ServerDialog.svelte:264-271 (manual branch).
		expect(result).toEqual<StreamingConfigInput>({
			srt_latency: 2000,
			relay_protocol: "srtla",
			srtla_addr: "custom.example",
			srtla_port: 5000,
			srt_streamid: "publish/abc",
		});
		// Exact key set (no relay_server, no relay_streamid_override).
		expect(new Set(Object.keys(result))).toEqual(
			new Set([
				"srt_latency",
				"relay_protocol",
				"srtla_addr",
				"srtla_port",
				"srt_streamid",
			]),
		);
	});

	it("managed relay emits relay fields incl. always-set relay_streamid_override", () => {
		const result = buildServerSetConfig(draft(), MANAGED);
		// Mirrors ServerDialog.svelte:276-279 (relay branch).
		expect(result).toEqual<StreamingConfigInput>({
			srt_latency: 2000,
			relay_protocol: "srtla",
			relay_server: "fra",
			relay_account: "acct-1",
			relay_streamid_override: "stream-id",
		});
		expect(result).not.toHaveProperty("srtla_addr");
	});

	it("omits relay_account when empty (today's `if (relayAccount)` guard)", () => {
		const result = buildServerSetConfig(draft({ relayAccount: "" }), MANAGED);
		expect(result).not.toHaveProperty("relay_account");
		expect(result).toEqual<StreamingConfigInput>({
			srt_latency: 2000,
			relay_protocol: "srtla",
			relay_server: "fra",
			relay_streamid_override: "stream-id",
		});
	});

	it("override emits srtla_addr/port + relay_streamid_override (no relay_server)", () => {
		const result = buildServerSetConfig(draft(), OVERRIDE);
		// Mirrors ServerDialog.svelte:272-275 (relayOverride branch).
		expect(result).toEqual<StreamingConfigInput>({
			srt_latency: 2000,
			relay_protocol: "srtla",
			srtla_addr: "override.example",
			srtla_port: 6000,
			relay_streamid_override: "stream-id",
		});
		expect(result).not.toHaveProperty("relay_server");
		expect(result).not.toHaveProperty("srt_streamid");
	});

	it("keeps relay_streamid_override present even when empty ('')", () => {
		const managed = buildServerSetConfig(draft({ relayStreamId: "" }), MANAGED);
		expect(managed).toHaveProperty("relay_streamid_override", "");

		const override = buildServerSetConfig(
			draft({ relayStreamId: "" }),
			OVERRIDE,
		);
		expect(override).toHaveProperty("relay_streamid_override", "");
	});

	it("trims address and stream-id inputs", () => {
		const result = buildServerSetConfig(
			draft({ addr: "  custom.example  ", streamId: "  publish/abc  " }),
			CUSTOM,
		);
		expect(result.srtla_addr).toBe("custom.example");
		expect(result.srt_streamid).toBe("publish/abc");
	});

	it("never emits a key with an undefined value (lock-loop safe)", () => {
		// An unparsable port yields `undefined` from parsePort; it MUST be pruned,
		// not emitted as `srtla_port: undefined` (which would slip past the
		// dirty-registry's `value !== undefined` lock filter).
		const result = buildServerSetConfig(draft({ portStr: "" }), CUSTOM);
		expect(result).not.toHaveProperty("srtla_port");
		for (const value of Object.values(result)) {
			expect(value).not.toBeUndefined();
		}
	});

	describe("LEGACY config (no relay_protocol)", () => {
		// A legacy persisted config carries only { srtla_addr, srtla_port } and no
		// relay_protocol field.
		const legacyConfig = { srtla_addr: "legacy.example", srtla_port: 4000 };

		it("derives a custom destination and a srtla_custom kind", () => {
			const destination: Destination = deriveDestination(legacyConfig);
			expect(destination).toBe("custom");
			expect(resolveReceiverKind({ protocol: undefined, destination })).toBe(
				"srtla_custom",
			);
		});

		it("emits relay_protocol:'srtla' (never undefined) for a legacy draft", () => {
			const result = buildServerSetConfig(
				draft({ protocol: undefined, addr: "legacy.example", portStr: "4000" }),
				CUSTOM,
			);
			expect(result.relay_protocol).toBe("srtla");
			expect(result).not.toHaveProperty("relay_protocol", undefined);
			expect(result).toEqual<StreamingConfigInput>({
				srt_latency: 2000,
				relay_protocol: "srtla",
				srtla_addr: "legacy.example",
				srtla_port: 4000,
				srt_streamid: "publish/abc",
			});
		});
	});
});

function summaryLabels(
	overrides: Partial<ServerSummaryLabels> = {},
): ServerSummaryLabels {
	const kinds: Record<string, string> = {
		srtla_relay: "SRTLA · Bonded",
		srtla_custom: "SRTLA · Custom",
		rist_relay: "RIST · Managed",
		rist_custom: "RIST · Custom",
		srt_custom: "SRT · Custom",
	};
	const providers: Record<string, string> = {
		ceralive: "CeraLive Cloud",
		belabox: "BELABOX Cloud",
	};
	return {
		notConfigured: "Not configured",
		kindLabel: (kind) => kinds[kind] ?? kind,
		bondedAcross: (count) => `Bonded across ${count} links`,
		singleLink: "Single link",
		providerLabel: (provider) => (provider ? providers[provider] : undefined),
		...overrides,
	};
}

describe("buildServerSummary — destination/kind-aware Live server summary (T11)", () => {
	it("none (no receiver configured) → notConfigured", () => {
		expect(buildServerSummary({}, undefined, 0, summaryLabels())).toBe(
			"Not configured",
		);
		expect(
			buildServerSummary(undefined, "srtla_custom", 3, summaryLabels()),
		).toBe("Not configured");
	});

	it("managed SRTLA relay while streaming → Provider · kind · bonded across N", () => {
		expect(
			buildServerSummary(
				{ relay_server: "fra", remote_provider: "ceralive" },
				"srtla_relay",
				3,
				summaryLabels(),
			),
		).toBe("CeraLive Cloud · SRTLA · Bonded · Bonded across 3 links");
	});

	it("managed SRTLA relay on a single active link → Provider · kind · single link", () => {
		expect(
			buildServerSummary(
				{ relay_server: "fra", remote_provider: "ceralive" },
				"srtla_relay",
				1,
				summaryLabels(),
			),
		).toBe("CeraLive Cloud · SRTLA · Bonded · Single link");
	});

	it("managed SRTLA relay while idle (0 links) → no fresh bonding clause", () => {
		expect(
			buildServerSummary(
				{ relay_server: "fra", remote_provider: "ceralive" },
				"srtla_relay",
				0,
				summaryLabels(),
			),
		).toBe("CeraLive Cloud · SRTLA · Bonded");
	});

	it("managed RIST relay never asserts bonding (even with multiple links)", () => {
		expect(
			buildServerSummary(
				{ relay_server: "fra", remote_provider: "belabox" },
				"rist_relay",
				4,
				summaryLabels(),
			),
		).toBe("BELABOX Cloud · RIST · Managed");
	});

	it("managed with an unknown/custom provider omits the brand prefix", () => {
		expect(
			buildServerSummary(
				{ relay_server: "fra" },
				"srtla_relay",
				0,
				summaryLabels(),
			),
		).toBe("SRTLA · Bonded");
	});

	it("custom SRTLA endpoint → addr:port · kind badge", () => {
		expect(
			buildServerSummary(
				{ srtla_addr: "custom.example", srtla_port: 5000 },
				"srtla_custom",
				0,
				summaryLabels(),
			),
		).toBe("custom.example:5000 · SRTLA · Custom");
	});

	it("custom RIST endpoint → addr:port · kind badge", () => {
		expect(
			buildServerSummary(
				{ srtla_addr: "rist.example", srtla_port: 5004 },
				"rist_custom",
				0,
				summaryLabels(),
			),
		).toBe("rist.example:5004 · RIST · Custom");
	});

	it("custom SRT endpoint → addr:port · kind badge", () => {
		expect(
			buildServerSummary(
				{ srtla_addr: "srt.example", srtla_port: 4001 },
				"srt_custom",
				0,
				summaryLabels(),
			),
		).toBe("srt.example:4001 · SRT · Custom");
	});

	it("custom endpoint without a port → addr · kind badge", () => {
		expect(
			buildServerSummary(
				{ srtla_addr: "custom.example" },
				"srtla_custom",
				0,
				summaryLabels(),
			),
		).toBe("custom.example · SRTLA · Custom");
	});
});

describe("autoSelectIngestSlot — managed ingest auto-detection (T19)", () => {
	it("no slots → custom fallback", () => {
		expect(autoSelectIngestSlot([], undefined)).toEqual({ kind: "custom" });
		expect(autoSelectIngestSlot([], "ep-1")).toEqual({ kind: "custom" });
	});

	it("exactly one slot → silent managed auto-select (reason single)", () => {
		const only = slot({ endpointId: "ep-only" });
		expect(autoSelectIngestSlot([only], undefined)).toEqual({
			kind: "managed",
			account: only,
			reason: "single",
		});
	});

	it("many slots → picks the default one", () => {
		const a = slot({ endpointId: "ep-a" });
		const b = slot({ endpointId: "ep-b", default: true });
		const c = slot({ endpointId: "ep-c" });
		expect(autoSelectIngestSlot([a, b, c], undefined)).toEqual({
			kind: "managed",
			account: b,
			reason: "default",
		});
	});

	it("many slots, no default → picks the last-used (selected_ingest_endpoint)", () => {
		const a = slot({ endpointId: "ep-a" });
		const b = slot({ endpointId: "ep-b" });
		expect(autoSelectIngestSlot([a, b], "ep-b")).toEqual({
			kind: "managed",
			account: b,
			reason: "lastUsed",
		});
	});

	it("default wins over last-used when both are present", () => {
		const a = slot({ endpointId: "ep-a", default: true });
		const b = slot({ endpointId: "ep-b" });
		expect(autoSelectIngestSlot([a, b], "ep-b")).toEqual({
			kind: "managed",
			account: a,
			reason: "default",
		});
	});

	it("many slots, no default and no last-used → prompt (never silent)", () => {
		const a = slot({ endpointId: "ep-a" });
		const b = slot({ endpointId: "ep-b" });
		expect(autoSelectIngestSlot([a, b], undefined)).toEqual({
			kind: "prompt",
			accounts: [a, b],
		});
		// A stale/unknown last-used id also falls through to prompt.
		expect(autoSelectIngestSlot([a, b], "ep-gone")).toEqual({
			kind: "prompt",
			accounts: [a, b],
		});
	});
});

describe("managedSlotLabel / findActiveSlot", () => {
	it("uses the platform label, falling back to endpointId", () => {
		expect(managedSlotLabel(slot({ label: "Studio A" }))).toBe("Studio A");
		expect(managedSlotLabel(slot({ label: "", endpointId: "ep-x" }))).toBe(
			"ep-x",
		);
	});

	it("resolves the active slot by endpointId, undefined when absent/unknown", () => {
		const a = slot({ endpointId: "ep-a" });
		const b = slot({ endpointId: "ep-b" });
		expect(findActiveSlot([a, b], "ep-b")).toBe(b);
		expect(findActiveSlot([a, b], undefined)).toBeUndefined();
		expect(findActiveSlot([a, b], "ep-gone")).toBeUndefined();
	});
});

describe("buildManagedSlotConfig — persisted slot selection", () => {
	it("persists the slot endpoint plus the stable selected_ingest_endpoint", () => {
		const result = buildManagedSlotConfig(
			slot({
				endpointId: "ep-1",
				host: "ingest1.example",
				port: 6000,
				protocol: "srtla",
				key: "publish/xyz",
			}),
			2500,
		);
		expect(result).toEqual<StreamingConfigInput>({
			srt_latency: 2500,
			relay_protocol: "srtla",
			srtla_addr: "ingest1.example",
			srtla_port: 6000,
			srt_streamid: "publish/xyz",
			selected_ingest_endpoint: "ep-1",
		});
		// No relay_server — a slot is a managed endpoint, not a catalog relay.
		expect(result).not.toHaveProperty("relay_server");
	});

	it("coerces an unknown slot protocol to srtla (never undefined)", () => {
		const result = buildManagedSlotConfig(slot({ protocol: "bogus" }), 2000);
		expect(result.relay_protocol).toBe("srtla");
	});
});

describe("groupRelayServersByProvider (T9)", () => {
	const ceralive = { id: "ceralive", name: "CeraLive Cloud", kind: "ceralive" } as const;
	const belabox = { id: "belabox", name: "BELABOX Cloud", kind: "belabox" } as const;

	const taggedEntries: [string, RelayServer][] = [
		["eu", relayServer({ name: "EU-West", provider: ceralive })],
		["us", relayServer({ name: "US-East", provider: ceralive })],
		["asia", relayServer({ name: "Asia-SE", provider: belabox })],
		["west", relayServer({ name: "US-West", provider: belabox })],
	];

	it("sees at least two providers across a multi-provider catalog", () => {
		const groups = groupRelayServersByProvider(taggedEntries, "ceralive");
		expect(groups.length).toBeGreaterThanOrEqual(2);
		expect(groups.map((g) => g.providerId)).toEqual(["ceralive", "belabox"]);
	});

	it("places each server in its tagged provider group", () => {
		const groups = groupRelayServersByProvider(taggedEntries, "ceralive");
		const byId = new Map(groups.map((g) => [g.providerId, g]));
		expect(byId.get("ceralive")?.servers.map(([id]) => id)).toEqual(["eu", "us"]);
		expect(byId.get("belabox")?.servers.map(([id]) => id)).toEqual(["asia", "west"]);
		expect(byId.get("belabox")?.kind).toBe("belabox");
		expect(byId.get("belabox")?.providerName).toBe("BELABOX Cloud");
	});

	it("falls back to the configured provider for untagged (legacy) servers", () => {
		const legacy: [string, RelayServer][] = [
			["a", relayServer({ name: "Legacy A" })],
			["b", relayServer({ name: "Legacy B" })],
		];
		const groups = groupRelayServersByProvider(legacy, "ceralive");
		expect(groups).toHaveLength(1);
		expect(groups[0]?.providerId).toBe("ceralive");
		expect(groups[0]?.kind).toBe("unknown");
		expect(groups[0]?.servers).toHaveLength(2);
	});
});

const CERALIVE = { id: "ceralive", name: "CeraLive Cloud", kind: "ceralive" } as const;
const BELABOX = { id: "belabox", name: "BELABOX Cloud", kind: "belabox" } as const;

describe("countRelayServersForProvider — per-provider D6 gate (T10)", () => {
	it("counts every untagged (legacy) server for the active provider", () => {
		const legacy: [string, RelayServer][] = [
			["a", relayServer()],
			["b", relayServer()],
		];
		expect(countRelayServersForProvider(legacy, "ceralive")).toBe(2);
		expect(countRelayServersForProvider(legacy, "belabox")).toBe(2);
	});

	it("counts only the tagged servers that belong to the selected provider", () => {
		const tagged: [string, RelayServer][] = [
			["eu", relayServer({ provider: CERALIVE })],
			["us", relayServer({ provider: CERALIVE })],
			["asia", relayServer({ provider: BELABOX })],
		];
		expect(countRelayServersForProvider(tagged, "ceralive")).toBe(2);
		expect(countRelayServersForProvider(tagged, "belabox")).toBe(1);
	});

	it("returns 0 when the selected provider has no servers", () => {
		const onlyBelabox: [string, RelayServer][] = [
			["asia", relayServer({ provider: BELABOX })],
		];
		expect(countRelayServersForProvider(onlyBelabox, "ceralive")).toBe(0);
		expect(countRelayServersForProvider([], "ceralive")).toBe(0);
	});
});

describe("autoSelectManagedRelay — managed relay auto-detection (T10)", () => {
	it("no servers for the provider → undefined (custom fallback)", () => {
		expect(autoSelectManagedRelay([], undefined, "ceralive")).toBeUndefined();
		const onlyBelabox: [string, RelayServer][] = [
			["asia", relayServer({ provider: BELABOX })],
		];
		expect(
			autoSelectManagedRelay(onlyBelabox, undefined, "ceralive"),
		).toBeUndefined();
	});

	it("exactly one server → silent single auto-select", () => {
		const entries: [string, RelayServer][] = [["fra", relayServer()]];
		expect(autoSelectManagedRelay(entries, undefined, "ceralive")).toEqual({
			kind: "single",
			serverId: "fra",
			server: entries[0]?.[1],
		});
	});

	it("many servers → picks the default-flagged one", () => {
		const entries: [string, RelayServer][] = [
			["eu", relayServer({ name: "EU" })],
			["us", relayServer({ name: "US", default: true })],
			["asia", relayServer({ name: "Asia" })],
		];
		expect(autoSelectManagedRelay(entries, undefined, "ceralive")).toEqual({
			kind: "default",
			serverId: "us",
			server: entries[1]?.[1],
		});
	});

	it("many servers, no default → picks the last-used (persisted relay_server)", () => {
		const entries: [string, RelayServer][] = [
			["eu", relayServer({ name: "EU" })],
			["us", relayServer({ name: "US" })],
		];
		expect(autoSelectManagedRelay(entries, "us", "ceralive")).toEqual({
			kind: "lastUsed",
			serverId: "us",
			server: entries[1]?.[1],
		});
	});

	it("default wins over last-used when both are present", () => {
		const entries: [string, RelayServer][] = [
			["eu", relayServer({ name: "EU", default: true })],
			["us", relayServer({ name: "US" })],
		];
		expect(autoSelectManagedRelay(entries, "us", "ceralive")).toEqual({
			kind: "default",
			serverId: "eu",
			server: entries[0]?.[1],
		});
	});

	it("many servers, no default and no last-used → prompt (never silent)", () => {
		const entries: [string, RelayServer][] = [
			["eu", relayServer({ name: "EU" })],
			["us", relayServer({ name: "US" })],
		];
		expect(autoSelectManagedRelay(entries, undefined, "ceralive")).toEqual({
			kind: "prompt",
			servers: entries,
		});
		// A stale/unknown last-used id also falls through to prompt.
		expect(autoSelectManagedRelay(entries, "gone", "ceralive")).toEqual({
			kind: "prompt",
			servers: entries,
		});
	});

	it("never auto-picks across providers — scopes to the selected provider only", () => {
		// One server per provider: selecting a provider auto-picks ITS single
		// server, never the other provider's, so no silent cross-cloud jump.
		const entries: [string, RelayServer][] = [
			["eu", relayServer({ name: "EU", provider: CERALIVE })],
			["asia", relayServer({ name: "Asia", provider: BELABOX })],
		];
		expect(autoSelectManagedRelay(entries, undefined, "ceralive")).toEqual({
			kind: "single",
			serverId: "eu",
			server: entries[0]?.[1],
		});
		expect(autoSelectManagedRelay(entries, undefined, "belabox")).toEqual({
			kind: "single",
			serverId: "asia",
			server: entries[1]?.[1],
		});
	});
});

describe("autoSelectManagedTransport — single + multi transport seed (T10)", () => {
	it("single advertised transport, not the current → seeds it (single transport→auto)", () => {
		expect(autoSelectManagedTransport(["rist"], "srtla")).toBe("rist");
	});

	it("single advertised transport already current → no change", () => {
		expect(autoSelectManagedTransport(["srtla"], "srtla")).toBeUndefined();
		expect(autoSelectManagedTransport(["rist"], "rist")).toBeUndefined();
	});

	it("multi transport, current unsupported → prefers bonded SRTLA when offered", () => {
		expect(autoSelectManagedTransport(["srtla", "rist"], "srt")).toBe("srtla");
	});

	it("multi transport, current unsupported and no SRTLA → first advertised", () => {
		expect(autoSelectManagedTransport(["rist", "srt"], "srtla")).toBe("rist");
	});

	it("multi transport, current already advertised → no change", () => {
		expect(autoSelectManagedTransport(["srtla", "rist"], "rist")).toBeUndefined();
	});

	it("no advertised transports → no change", () => {
		expect(autoSelectManagedTransport([], "srtla")).toBeUndefined();
	});
});
