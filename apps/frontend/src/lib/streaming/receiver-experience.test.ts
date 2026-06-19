// @vitest-environment jsdom
import type { RelayServer, StreamingConfigInput } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	buildServerSetConfig,
	type Destination,
	deriveDestination,
	kindBadgeLabelKey,
	resolveReceiverKind,
	type ServerSetDerived,
	type ServerSetDraft,
} from "./receiver-experience";

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
