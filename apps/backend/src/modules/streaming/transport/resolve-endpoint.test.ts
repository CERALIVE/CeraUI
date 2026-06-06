import { describe, expect, it } from "bun:test";

import type { RelaysCache } from "../../../helpers/config-schemas.ts";

import {
	resolveStreamEndpoint,
	type StreamResolutionInput,
} from "./resolve-endpoint.ts";

// =============================================================================
// Fixtures
// =============================================================================

/**
 * Flat (un-namespaced) relays cache — mirrors the live `getRelays()` snapshot.
 * Provider identity is carried by the namespaced *selection* ids, NOT by the
 * cache keys (Task 7/9 design: cache stays flat, selections may be namespaced).
 */
const relays: RelaysCache = {
	servers: {
		"0": {
			type: "srtla",
			name: "Default Relay",
			addr: "relay.example.com",
			port: 5000,
			default: true,
		},
		"1": {
			type: "srtla",
			name: "Backup Relay",
			addr: "backup.example.com",
			port: 6000,
		},
	},
	accounts: {
		acct1: { name: "Main Account", ingest_key: "KEY_MAIN" },
		acct2: { name: "Second Account", ingest_key: "KEY_SECOND", disabled: true },
	},
};

// =============================================================================
// Golden resolution scenarios
// =============================================================================

describe("resolveStreamEndpoint — golden resolution", () => {
	it("subscription + account → auto streamid (account ingest_key)", () => {
		const input: StreamResolutionInput = {
			relay_server: "0",
			relay_account: "acct1",
		};
		expect(resolveStreamEndpoint(input, relays)).toEqual({
			srtlaAddr: "relay.example.com",
			srtlaPort: 5000,
			streamid: "KEY_MAIN",
		});
	});

	it("subscription + override → user-entered streamid wins over ingest_key", () => {
		const input: StreamResolutionInput = {
			relay_server: "0",
			relay_account: "acct1",
			relay_streamid_override: "USER_CUSTOM_ID",
		};
		expect(resolveStreamEndpoint(input, relays)).toEqual({
			srtlaAddr: "relay.example.com",
			srtlaPort: 5000,
			streamid: "USER_CUSTOM_ID",
		});
	});

	it("manual mode → manual addr/port + manual srt_streamid", () => {
		const input: StreamResolutionInput = {
			srtla_addr: "  manual.host  ",
			srtla_port: 4000,
			srt_streamid: "MANUAL_STREAM_ID",
		};
		expect(resolveStreamEndpoint(input, undefined)).toEqual({
			srtlaAddr: "manual.host", // trimmed
			srtlaPort: 4000,
			streamid: "MANUAL_STREAM_ID",
		});
	});

	it("namespaced ids resolve identically to flat ids (namespace stripped)", () => {
		const input: StreamResolutionInput = {
			relay_server: "ceralive:0",
			relay_account: "ceralive:acct1",
		};
		expect(resolveStreamEndpoint(input, relays)).toEqual({
			srtlaAddr: "relay.example.com",
			srtlaPort: 5000,
			streamid: "KEY_MAIN",
		});
	});

	it("provider-switch consistency: different provider namespaces, same flat serverId → same endpoint", () => {
		const flat = resolveStreamEndpoint(
			{ relay_server: "1", relay_account: "acct1" },
			relays,
		);
		const ceralive = resolveStreamEndpoint(
			{ relay_server: "ceralive:1", relay_account: "ceralive:acct1" },
			relays,
		);
		const belabox = resolveStreamEndpoint(
			{ relay_server: "belabox:1", relay_account: "belabox:acct1" },
			relays,
		);
		expect(ceralive).toEqual(flat);
		expect(belabox).toEqual(flat);
		expect(flat).toEqual({
			srtlaAddr: "backup.example.com",
			srtlaPort: 6000,
			streamid: "KEY_MAIN",
		});
	});
});

// =============================================================================
// Stream ID override precedence
// =============================================================================

describe("resolveStreamEndpoint — streamid override precedence", () => {
	it("(1) override beats (2) account ingest_key", () => {
		const { streamid } = resolveStreamEndpoint(
			{ relay_server: "0", relay_account: "acct1", relay_streamid_override: "OVR" },
			relays,
		);
		expect(streamid).toBe("OVR");
	});

	it("(2) account ingest_key used when override is absent", () => {
		const { streamid } = resolveStreamEndpoint(
			{ relay_server: "0", relay_account: "acct1" },
			relays,
		);
		expect(streamid).toBe("KEY_MAIN");
	});

	it("(3) manual srt_streamid used when no relay + no override", () => {
		const { streamid } = resolveStreamEndpoint(
			{ srtla_addr: "h", srtla_port: 4000, srt_streamid: "MANUAL" },
			undefined,
		);
		expect(streamid).toBe("MANUAL");
	});

	it("empty-string override is treated as unset (falls back to ingest_key)", () => {
		const { streamid } = resolveStreamEndpoint(
			{ relay_server: "0", relay_account: "acct1", relay_streamid_override: "" },
			relays,
		);
		expect(streamid).toBe("KEY_MAIN");
	});

	it("override also wins in manual mode", () => {
		const { streamid } = resolveStreamEndpoint(
			{
				srtla_addr: "h",
				srtla_port: 4000,
				srt_streamid: "MANUAL",
				relay_streamid_override: "OVR",
			},
			undefined,
		);
		expect(streamid).toBe("OVR");
	});
});

// =============================================================================
// Protocol selection + error parity (golden messages preserved)
// =============================================================================

describe("resolveStreamEndpoint — protocol + errors", () => {
	it("defaults to srtla when neither input nor fallback protocol is set", () => {
		expect(
			resolveStreamEndpoint({ relay_server: "0", relay_account: "acct1" }, relays),
		).toEqual({
			srtlaAddr: "relay.example.com",
			srtlaPort: 5000,
			streamid: "KEY_MAIN",
		});
	});

	it("explicit srtla protocol resolves", () => {
		expect(
			resolveStreamEndpoint(
				{ relay_server: "0", relay_account: "acct1", relay_protocol: "srtla" },
				relays,
			).srtlaAddr,
		).toBe("relay.example.com");
	});

	it("fallbackProtocol used when input.relay_protocol is unset", () => {
		expect(
			resolveStreamEndpoint(
				{ relay_server: "0", relay_account: "acct1" },
				relays,
				"srtla",
			).srtlaPort,
		).toBe(5000);
	});

	it("unknown protocol throws UnknownProtocolError", () => {
		expect(() =>
			resolveStreamEndpoint(
				{
					relay_server: "0",
					relay_account: "acct1",
					// biome-ignore lint/suspicious/noExplicitAny: testing invalid protocol
					relay_protocol: "nope" as any,
				},
				relays,
			),
		).toThrow("Unknown transport protocol: nope");
	});

	it("srt protocol (placeholder) throws NotImplementedError", () => {
		expect(() =>
			resolveStreamEndpoint(
				{ relay_server: "0", relay_account: "acct1", relay_protocol: "srt" },
				relays,
			),
		).toThrow("SRT not yet implemented");
	});

	it("invalid relay server id throws golden message", () => {
		expect(() =>
			resolveStreamEndpoint({ relay_server: "99", relay_account: "acct1" }, relays),
		).toThrow("Invalid relay server");
	});

	it("invalid relay account id throws golden message", () => {
		expect(() =>
			resolveStreamEndpoint({ relay_server: "0", relay_account: "nope" }, relays),
		).toThrow("Invalid relay account specified!");
	});

	it("manual mode missing addr throws golden message", () => {
		expect(() =>
			resolveStreamEndpoint({ srt_streamid: "x" }, undefined),
		).toThrow("Invalid SRTLA address");
	});

	it("manual mode missing streamid throws golden message", () => {
		expect(() =>
			resolveStreamEndpoint({ srtla_addr: "h", srtla_port: 4000 }, undefined),
		).toThrow("SRT streamid not specified");
	});
});
