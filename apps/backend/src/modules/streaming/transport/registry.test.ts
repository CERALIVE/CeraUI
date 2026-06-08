import { describe, expect, it } from "bun:test";

import type { RelaysCache } from "../../../helpers/config-schemas.ts";
import { validatePortNo } from "../../../helpers/number.ts";

import { belaboxDetectionMethod } from "./belabox-detection.ts";
import {
	getAdapter,
	getDetectionMethod,
	listProtocols,
	registerDetectionMethod,
	registerProtocol,
} from "./registry.ts";
import { srtlaAdapter } from "./srtla-adapter.ts";
import {
	type DetectionMethod,
	NotImplementedError,
	type TransportAdapter,
	type TransportConfig,
	UnknownProtocolError,
} from "./types.ts";

// =============================================================================
// Golden oracle
// =============================================================================

/**
 * Literal transcription of streaming.ts:172-197 — the resolution logic the
 * SRTLA adapter must reproduce byte-for-byte. Kept inline so the test fails
 * loudly if the adapter ever diverges from the original `validateConfig`.
 *
 * Uses the RAW relay ids (no namespace stripping) exactly like the current
 * streaming.ts. Fixtures below use flat ids so the adapter (which strips the
 * namespace before lookup) yields identical output for the golden cases.
 */
function goldenResolve(cfg: TransportConfig): {
	addr: string;
	port: number;
	streamid: string;
} {
	const relays = cfg.relays;

	// SRTLA addr and port
	let addr: string;
	let port: number;
	if (relays && cfg.relay_server) {
		const relayServer = relays.servers[cfg.relay_server];
		if (!relayServer) throw new Error("Invalid relay server");
		addr = relayServer.addr;
		port = relayServer.port;
	} else {
		if (typeof cfg.srtla_addr !== "string")
			throw new Error("Invalid SRTLA address");
		addr = cfg.srtla_addr.trim();

		const validated = validatePortNo(cfg.srtla_port);
		if (!validated) throw new Error(`Invalid SRTLA port '${cfg.srtla_port}'`);
		port = validated;
	}

	// stream ID
	let streamid: string;
	if (relays && cfg.relay_server && cfg.relay_account) {
		const relayAccount = relays.accounts[cfg.relay_account];
		if (!relayAccount) throw new Error("Invalid relay account specified!");
		streamid = relayAccount.ingest_key;
	} else {
		if (typeof cfg.srt_streamid !== "string")
			throw new Error("SRT streamid not specified");
		streamid = cfg.srt_streamid;
	}

	return { addr, port, streamid };
}

// Golden relays-cache fixture (flat ids, mirrors getRelays() output shape).
const relays: RelaysCache = {
	servers: {
		"0": {
			type: "srtla",
			name: "Primary",
			addr: "relay.example.com",
			port: 5000,
		},
		"1": {
			type: "srtla",
			name: "Backup",
			addr: "backup.example.com",
			port: 6000,
			default: true,
		},
	},
	accounts: {
		acc1: { name: "Account 1", ingest_key: "KEY-12345" },
	},
};

// =============================================================================
// Registry routing
// =============================================================================

describe("transport registry — protocol routing", () => {
	it("returns the SRTLA adapter for the 'srtla' protocol", () => {
		const adapter = getAdapter("srtla");
		expect(adapter).toBe(srtlaAdapter);
		expect(adapter.protocol).toBe("srtla");
	});

	it("registers srtla, srt and rist by default", () => {
		const protocols = listProtocols();
		expect(protocols).toContain("srtla");
		expect(protocols).toContain("srt");
		expect(protocols).toContain("rist");
	});

	it("throws UnknownProtocolError for an unregistered protocol", () => {
		expect(() => getAdapter("telnet")).toThrow(UnknownProtocolError);
	});

	it("names the offending protocol in the UnknownProtocolError", () => {
		try {
			getAdapter("telnet");
			throw new Error("expected getAdapter to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(UnknownProtocolError);
			expect((err as Error).message).toContain("telnet");
		}
	});
});

// =============================================================================
// Placeholder protocols
// =============================================================================

describe("transport registry — srt/rist placeholders", () => {
	it("returns an adapter for 'srt' that throws NotImplementedError on resolve", () => {
		const adapter = getAdapter("srt");
		expect(adapter.protocol).toBe("srt");
		expect(() => adapter.resolveEndpoint({})).toThrow(NotImplementedError);
		expect(() => adapter.resolveEndpoint({})).toThrow(
			"SRT not yet implemented",
		);
	});

	it("returns an adapter for 'rist' that throws NotImplementedError on resolve", () => {
		const adapter = getAdapter("rist");
		expect(adapter.protocol).toBe("rist");
		expect(() => adapter.resolveEndpoint({})).toThrow(NotImplementedError);
		expect(() => adapter.resolveEndpoint({})).toThrow(
			"RIST not yet implemented",
		);
	});

	it("reports placeholders as not implemented via describe()", () => {
		expect(getAdapter("srt").describe().implemented).toBe(false);
		expect(getAdapter("rist").describe().implemented).toBe(false);
		expect(getAdapter("srtla").describe().implemented).toBe(true);
	});
});

// =============================================================================
// SRTLA adapter — golden parity
// =============================================================================

describe("srtla adapter — resolveEndpoint golden parity", () => {
	it("resolves addr/port/streamid from the relay cache (relay mode)", () => {
		const cfg: TransportConfig = {
			relay_server: "0",
			relay_account: "acc1",
			relays,
		};
		const out = srtlaAdapter.resolveEndpoint(cfg);
		expect(out).toEqual({
			addr: "relay.example.com",
			port: 5000,
			streamid: "KEY-12345",
		});
		expect(out).toEqual(goldenResolve(cfg));
	});

	it("uses relay addr/port but manual streamid when no relay_account is set", () => {
		const cfg: TransportConfig = {
			relay_server: "1",
			srt_streamid: "manual-stream-id",
			relays,
		};
		const out = srtlaAdapter.resolveEndpoint(cfg);
		expect(out).toEqual({
			addr: "backup.example.com",
			port: 6000,
			streamid: "manual-stream-id",
		});
		expect(out).toEqual(goldenResolve(cfg));
	});

	it("resolves manual addr/port/streamid and trims the address (manual mode)", () => {
		const cfg: TransportConfig = {
			srtla_addr: "  manual.example.com  ",
			srtla_port: 7000,
			srt_streamid: "abc123",
		};
		const out = srtlaAdapter.resolveEndpoint(cfg);
		expect(out).toEqual({
			addr: "manual.example.com",
			port: 7000,
			streamid: "abc123",
		});
		expect(out).toEqual(goldenResolve(cfg));
	});

	it("falls back to manual mode when relays exist but no relay_server is set", () => {
		const cfg: TransportConfig = {
			srtla_addr: "manual.example.com",
			srtla_port: 8000,
			srt_streamid: "xyz",
			relays,
		};
		const out = srtlaAdapter.resolveEndpoint(cfg);
		expect(out).toEqual({
			addr: "manual.example.com",
			port: 8000,
			streamid: "xyz",
		});
		expect(out).toEqual(goldenResolve(cfg));
	});

	it("strips a provider namespace before the relay-cache lookup", () => {
		// Namespaced ids ("ceralive:0") must resolve identically to flat ids ("0").
		const cfg: TransportConfig = {
			relay_server: "ceralive:0",
			relay_account: "ceralive:acc1",
			relays,
		};
		const out = srtlaAdapter.resolveEndpoint(cfg);
		expect(out).toEqual({
			addr: "relay.example.com",
			port: 5000,
			streamid: "KEY-12345",
		});
	});
});

// =============================================================================
// SRTLA adapter — validation / error parity
// =============================================================================

describe("srtla adapter — error parity", () => {
	it("throws 'Invalid relay server' for an unknown relay_server", () => {
		expect(() =>
			srtlaAdapter.resolveEndpoint({ relay_server: "999", relays }),
		).toThrow("Invalid relay server");
	});

	it("throws 'Invalid relay account specified!' for an unknown relay_account", () => {
		expect(() =>
			srtlaAdapter.resolveEndpoint({
				relay_server: "0",
				relay_account: "nope",
				relays,
			}),
		).toThrow("Invalid relay account specified!");
	});

	it("throws 'Invalid SRTLA address' when manual addr is missing", () => {
		expect(() =>
			srtlaAdapter.resolveEndpoint({ srtla_port: 7000, srt_streamid: "x" }),
		).toThrow("Invalid SRTLA address");
	});

	it("throws 'Invalid SRTLA port' when manual port is invalid", () => {
		expect(() =>
			srtlaAdapter.resolveEndpoint({
				srtla_addr: "host.example.com",
				srtla_port: 0,
				srt_streamid: "x",
			}),
		).toThrow("Invalid SRTLA port");
	});

	it("throws 'SRT streamid not specified' when manual streamid is missing", () => {
		expect(() =>
			srtlaAdapter.resolveEndpoint({
				srtla_addr: "host.example.com",
				srtla_port: 7000,
			}),
		).toThrow("SRT streamid not specified");
	});

	it("validate() accepts a resolvable config and rejects an invalid one", () => {
		expect(() =>
			srtlaAdapter.validate({
				relay_server: "0",
				relay_account: "acc1",
				relays,
			}),
		).not.toThrow();
		expect(() =>
			srtlaAdapter.validate({ relay_server: "999", relays }),
		).toThrow("Invalid relay server");
	});
});

// =============================================================================
// Extension points
// =============================================================================

describe("transport registry — extension points", () => {
	it("registerProtocol overrides the adapter for a protocol and getAdapter returns it", () => {
		const stub: TransportAdapter = {
			protocol: "srtla",
			validate: () => {},
			resolveEndpoint: () => ({ addr: "stub", port: 1, streamid: "s" }),
			describe: () => ({ protocol: "srtla", label: "stub", implemented: true }),
		};
		try {
			registerProtocol(stub);
			expect(getAdapter("srtla")).toBe(stub);
		} finally {
			// Restore the real adapter so adapter ordering doesn't leak across tests.
			registerProtocol(srtlaAdapter);
		}
		expect(getAdapter("srtla")).toBe(srtlaAdapter);
	});

	it("registerDetectionMethod stores a strategy retrievable by id", () => {
		const method: DetectionMethod = {
			method: "subscription",
			describe: () => "Subscription push",
		};
		registerDetectionMethod(method);
		expect(getDetectionMethod("subscription")).toBe(method);
	});

	it("registers the BELABOX detection method by default (Task 10)", () => {
		const method = getDetectionMethod("belabox");
		expect(method).toBe(belaboxDetectionMethod);
		expect(method?.providerKind).toBe("belabox");
		expect(typeof method?.normalize).toBe("function");
	});

	it("returns undefined for an unregistered detection method", () => {
		expect(getDetectionMethod("manual")).toBeUndefined();
	});
});
