import { describe, expect, test } from "bun:test";

// Version-skew guard for the @ceralive/srtla binding surface.
//
// CeraUI's backend resolves @ceralive/srtla via a pnpm `link:` path to a
// sibling checkout (srtla/bindings/typescript). That link resolves at RUNTIME,
// not at build/install time: if the linked bindings are rebuilt from a branch
// whose exported surface drifted (rename / removal / signature change), `bun
// tsc` against CeraUI may still pass while the actual import explodes when the
// stream starts on-device.
//
// This test imports the EXACT exports that `streamloop.ts` consumes from
// `@ceralive/srtla/sender` and asserts their identity and runtime contract.
// If the upstream srtla merge renames, removes, or changes the shape of any of
// these, this test fails immediately and loudly instead of failing silently in
// production.
//
// Guarded exports (must stay in lockstep with streamloop.ts imports):
//   - buildSrtlaSendArgs
//   - getSrtlaSendExec

import * as sender from "@ceralive/srtla/sender";
import { buildSrtlaSendArgs, getSrtlaSendExec } from "@ceralive/srtla/sender";

describe("srtla bindings version-skew guard", () => {
	test("required sender exports exist and are callable", () => {
		// Existence + type. A rename/removal in the merged bindings turns these
		// into `undefined`, which trips the assertion rather than silently
		// importing `undefined` and crashing at stream start.
		expect(typeof sender.buildSrtlaSendArgs).toBe("function");
		expect(typeof sender.getSrtlaSendExec).toBe("function");

		// Named-import binding identity must match the namespace member.
		expect(buildSrtlaSendArgs).toBe(sender.buildSrtlaSendArgs);
		expect(getSrtlaSendExec).toBe(sender.getSrtlaSendExec);
	});

	test("buildSrtlaSendArgs honors the positional CLI contract streamloop relies on", () => {
		// Shape: <listen_port> <srtla_host> <srtla_port> <ips_file> [--verbose]
		const result = buildSrtlaSendArgs({
			listenPort: 9000,
			srtlaHost: "relay.example.com",
			srtlaPort: 8890,
			ipsFile: "/tmp/srtla_ips",
			verbose: true,
		});

		// Return contract: { args: string[], options: parsed }
		expect(Array.isArray(result.args)).toBe(true);
		expect(result.options).toBeDefined();

		// Positional ordering is load-bearing for srtla_send — a reordering or
		// flag-shape change in the bindings must fail here.
		expect(result.args).toEqual([
			"9000",
			"relay.example.com",
			"8890",
			"/tmp/srtla_ips",
			"--verbose",
		]);

		// Parsed options surface used downstream (execPath flows into spawn).
		expect(result.options.listenPort).toBe(9000);
		expect(result.options.srtlaHost).toBe("relay.example.com");
		expect(result.options.srtlaPort).toBe(8890);
		expect(result.options.ipsFile).toBe("/tmp/srtla_ips");
	});

	test("buildSrtlaSendArgs omits --verbose by default", () => {
		const { args } = buildSrtlaSendArgs({
			srtlaHost: "relay.example.com",
		});
		expect(args).not.toContain("--verbose");
		// Defaults must remain stable: listenPort 5000, ipsFile /tmp/srtla_ips.
		expect(args[0]).toBe("5000");
		expect(args[3]).toBe("/tmp/srtla_ips");
	});

	test("getSrtlaSendExec resolves to a non-empty executable string", () => {
		// streamloop.ts: `export const srtlaSendExec = getSrtlaSendExec(setup.srtla_path)`
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
