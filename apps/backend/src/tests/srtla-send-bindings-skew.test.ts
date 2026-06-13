import { describe, expect, test } from "bun:test";

// Version-skew guard for the @ceralive/srtla-send binding surface
// (registry-pinned dep).
//
// CeraUI's backend resolves @ceralive/srtla-send from the registry
// (GitHub Packages, @ceralive scope) — pinned in apps/backend/package.json,
// NOT a sibling `link:` and NOT a vendored tarball. A registry republish that
// drifts the exported surface (rename / removal / signature change) can pass
// `bun tsc` against a stale lockfile while the actual import explodes when the
// stream starts on-device.
//
// This test imports the EXACT exports that streamloop.ts + link-telemetry.ts
// consume from `@ceralive/srtla-send/{sender,telemetry}` and asserts their
// identity and runtime contract. If a refreshed @ceralive/srtla-send renames,
// removes, or changes the shape of any of these, this test fails immediately
// and loudly instead of failing silently in production.
//
// Guarded sender exports (must stay in lockstep with the consumers):
//   - buildSrtlaSendArgs
//   - getSrtlaSendExec
//   - spawnSrtlaSend
//   - sendSrtlaSendHup
//   - isSrtlaSendRunning
//   - srtlaSendOptionsSchema
//   - SrtlaSendOptions (type)
//
// The link-telemetry module (modules/streaming/link-telemetry.ts) additionally
// consumes the @ceralive/srtla-send/telemetry surface; those exports are
// guarded in the second describe block below for the same fail-loud reason.

import * as sender from "@ceralive/srtla-send/sender";
import {
	buildSrtlaSendArgs,
	getSrtlaSendExec,
	isSrtlaSendRunning,
	sendSrtlaSendHup,
	type SrtlaSendOptions,
	spawnSrtlaSend,
	srtlaSendOptionsSchema,
} from "@ceralive/srtla-send/sender";
import * as telemetry from "@ceralive/srtla-send/telemetry";
import {
	connectionTelemetrySchema,
	readTelemetry,
	SENDER_TELEMETRY_PATH_PREFIX,
	SENDER_TELEMETRY_STALE_MS,
	senderTelemetryPath,
	telemetrySchema,
	watchTelemetry,
} from "@ceralive/srtla-send/telemetry";
import { SRTLA_LISTEN_PORT } from "../modules/streaming/constants.ts";

// Compile-time guard: SrtlaSendOptions must remain an exported type whose shape
// includes the positional CLI fields. A rename/removal turns this into an error.
const _typeGuard: SrtlaSendOptions = {
	listenPort: 5000,
	srtlaHost: "relay.example.com",
	srtlaPort: 5001,
	ipsFile: "/tmp/srtla_ips",
};
void _typeGuard;

describe("srtla-send bindings version-skew guard", () => {
	test("required sender exports exist and are callable", () => {
		// Existence + type. A rename/removal in a refreshed binding turns these
		// into `undefined`, which trips the assertion rather than silently
		// importing `undefined` and crashing at stream start.
		expect(typeof sender.buildSrtlaSendArgs).toBe("function");
		expect(typeof sender.getSrtlaSendExec).toBe("function");
		expect(typeof sender.spawnSrtlaSend).toBe("function");
		expect(typeof sender.sendSrtlaSendHup).toBe("function");
		expect(typeof sender.isSrtlaSendRunning).toBe("function");

		// srtlaSendOptionsSchema is a Zod object exposing .parse.
		expect(typeof sender.srtlaSendOptionsSchema).toBe("object");
		expect(typeof sender.srtlaSendOptionsSchema.parse).toBe("function");

		// Named-import binding identity must match the namespace member.
		expect(buildSrtlaSendArgs).toBe(sender.buildSrtlaSendArgs);
		expect(getSrtlaSendExec).toBe(sender.getSrtlaSendExec);
		expect(spawnSrtlaSend).toBe(sender.spawnSrtlaSend);
		expect(sendSrtlaSendHup).toBe(sender.sendSrtlaSendHup);
		expect(isSrtlaSendRunning).toBe(sender.isSrtlaSendRunning);
		expect(srtlaSendOptionsSchema).toBe(sender.srtlaSendOptionsSchema);
	});

	test("buildSrtlaSendArgs honors the positional CLI contract streamloop relies on", () => {
		// Shape: <listen_port> <srtla_host> <srtla_port> <ips_file> [--verbose]
		// srtla-send's buildSrtlaSendArgs returns the argv array directly.
		const args = buildSrtlaSendArgs({
			listenPort: 9000,
			srtlaHost: "relay.example.com",
			srtlaPort: 8890,
			ipsFile: "/tmp/srtla_ips",
			verbose: true,
		});

		expect(Array.isArray(args)).toBe(true);

		// Positional ordering is load-bearing for srtla_send — a reordering or
		// flag-shape change in the binding must fail here.
		expect(args).toEqual([
			"9000",
			"relay.example.com",
			"8890",
			"/tmp/srtla_ips",
			"--verbose",
		]);
	});

	test("buildSrtlaSendArgs omits --verbose by default", () => {
		const args = buildSrtlaSendArgs({
			srtlaHost: "relay.example.com",
		});
		expect(args).not.toContain("--verbose");
		// Defaults must remain stable: listenPort 5000, ipsFile /tmp/srtla_ips.
		expect(args[0]).toBe("5000");
		expect(args[3]).toBe("/tmp/srtla_ips");
	});

	test("srtlaSendOptionsSchema applies the documented defaults", () => {
		// streamloop builds options against this schema; a default drift would
		// silently change the spawned argv.
		const parsed = srtlaSendOptionsSchema.parse({
			srtlaHost: "relay.example.com",
		});
		expect(parsed.listenPort).toBe(5000);
		expect(parsed.srtlaPort).toBe(5001);
		expect(parsed.ipsFile).toBe("/tmp/srtla_ips");
	});

	test("getSrtlaSendExec resolves to a non-empty executable string", () => {
		// streamloop: `srtlaSendExec = getSrtlaSendExec(setup.srtla_path)`.
		// Must accept an optional dir override and return a string path.
		const resolved = getSrtlaSendExec("/usr/bin");
		expect(typeof resolved).toBe("string");
		expect(resolved.length).toBeGreaterThan(0);
		expect(resolved).toContain("srtla_send");

		// Called with no argument (system PATH resolution) must still return a
		// string — never throw, never return undefined.
		const fallback = getSrtlaSendExec();
		expect(typeof fallback).toBe("string");
		expect(fallback.length).toBeGreaterThan(0);
	});
});

describe("srtla-send telemetry bindings version-skew guard", () => {
	test("required telemetry exports exist with the expected shapes", () => {
		expect(typeof telemetry.senderTelemetryPath).toBe("function");
		expect(typeof telemetry.watchTelemetry).toBe("function");
		expect(typeof telemetry.readTelemetry).toBe("function");

		// Zod schemas expose .parse.
		expect(typeof telemetry.telemetrySchema.parse).toBe("function");
		expect(typeof telemetry.connectionTelemetrySchema.parse).toBe("function");

		// Numeric/string contract constants.
		expect(typeof telemetry.SENDER_TELEMETRY_STALE_MS).toBe("number");
		expect(typeof telemetry.SENDER_TELEMETRY_PATH_PREFIX).toBe("string");

		// Named-import identity must match the namespace member.
		expect(senderTelemetryPath).toBe(telemetry.senderTelemetryPath);
		expect(watchTelemetry).toBe(telemetry.watchTelemetry);
		expect(readTelemetry).toBe(telemetry.readTelemetry);
		expect(telemetrySchema).toBe(telemetry.telemetrySchema);
		expect(connectionTelemetrySchema).toBe(
			telemetry.connectionTelemetrySchema,
		);
		expect(SENDER_TELEMETRY_STALE_MS).toBe(telemetry.SENDER_TELEMETRY_STALE_MS);
		expect(SENDER_TELEMETRY_PATH_PREFIX).toBe(
			telemetry.SENDER_TELEMETRY_PATH_PREFIX,
		);
	});

	test("senderTelemetryPath derives the listen-port stats path link-telemetry relies on", () => {
		// link-telemetry.ts computes the --stats-file path from the listen port;
		// a change to this convention would silently break producer/consumer pairing.
		expect(senderTelemetryPath(SRTLA_LISTEN_PORT)).toBe(
			"/tmp/srtla-send-stats-9000.json",
		);
		// The path-prefix constant must stay aligned with the derived path.
		expect(senderTelemetryPath(SRTLA_LISTEN_PORT)).toBe(
			`${SENDER_TELEMETRY_PATH_PREFIX}${SRTLA_LISTEN_PORT}.json`,
		);
	});

	test("watchTelemetry returns a handle with an idempotent stop()", () => {
		// startLinkTelemetry depends on { stop } to halt polling on stream stop.
		const handle = watchTelemetry(
			"/tmp/ceralive-skew-nonexistent.json",
			() => {},
			{ intervalMs: 60_000 },
		);
		expect(typeof handle.stop).toBe("function");
		handle.stop();
		handle.stop(); // idempotent — must not throw
	});
});
