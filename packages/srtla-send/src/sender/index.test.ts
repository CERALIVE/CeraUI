import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";

import {
	buildCapabilitiesProbeArgs,
	buildSrtlaSendArgs,
	CAPABILITIES_JSON_FLAG,
	CONN_TIMEOUT_MS,
	DEFAULT_SRTLA_SEND_PATH,
	getSrtlaSendExec,
	spawnSrtlaSend,
} from "./index";

describe("buildSrtlaSendArgs", () => {
	// QA SNAPSHOT (plan upstream-rebase-hard-fork, todo 40): the EXACT emitted
	// vector. The four positionals lead, in order, and `--conn-timeout-ms 15000`
	// is present on every spawn — the sender keeps upstream's 5 s constant
	// unpatched, so this flag IS the device's 15 s link-liveness timeout. A
	// change to either the positional order or the timeout value fails here
	// before it can reach a device.
	test("buildSrtlaSendArgs_exact_vector_snapshot", () => {
		const args = buildSrtlaSendArgs({
			listenPort: 6000,
			srtlaHost: "relay.example.com",
			srtlaPort: 5000,
			ipsFile: "/tmp/srtla_ips",
			verbose: true,
			statsFile: "/tmp/srtla-send-stats-6000.json",
			statsFileInterval: 1000,
			controlSocket: "/tmp/srtla-send-control-6000.sock",
			bindMap: "/tmp/srtla-bind-map.json",
			noRehome: true,
			noStallDeselect: true,
		});

		expect(args).toEqual([
			"6000",
			"relay.example.com",
			"5000",
			"/tmp/srtla_ips",
			"--conn-timeout-ms",
			"15000",
			"--verbose",
			"--stats-file",
			"/tmp/srtla-send-stats-6000.json",
			"--stats-file-interval",
			"1000",
			"--control-socket",
			"/tmp/srtla-send-control-6000.sock",
			"--bind-map",
			"/tmp/srtla-bind-map.json",
			"--no-rehome",
			"--no-stall-deselect",
		]);

		// Stated separately so a failure names WHICH half of the contract broke.
		expect(args.slice(0, 4)).toEqual([
			"6000",
			"relay.example.com",
			"5000",
			"/tmp/srtla_ips",
		]);
		const timeoutIdx = args.indexOf("--conn-timeout-ms");
		expect(timeoutIdx).toBeGreaterThanOrEqual(4);
		expect(args[timeoutIdx + 1]).toBe(String(CONN_TIMEOUT_MS));
	});

	test("buildSrtlaSendArgs_positional_order", () => {
		const args = buildSrtlaSendArgs({
			listenPort: 6000,
			srtlaHost: "host",
			srtlaPort: 5000,
			ipsFile: "ips",
			verbose: true,
			statsFile: "/p",
			statsFileInterval: 1000,
		});
		expect(args).toEqual([
			"6000",
			"host",
			"5000",
			"ips",
			"--conn-timeout-ms",
			"15000",
			"--verbose",
			"--stats-file",
			"/p",
			"--stats-file-interval",
			"1000",
		]);
	});

	test("buildSrtlaSendArgs_minimal", () => {
		const args = buildSrtlaSendArgs({
			listenPort: 6000,
			srtlaHost: "host",
			srtlaPort: 5000,
			ipsFile: "ips",
		});
		expect(args).toEqual([
			"6000",
			"host",
			"5000",
			"ips",
			"--conn-timeout-ms",
			"15000",
		]);
	});

	test("buildSrtlaSendArgs_applies_defaults", () => {
		const args = buildSrtlaSendArgs({ srtlaHost: "relay.example.com" });
		expect(args).toEqual([
			"5000",
			"relay.example.com",
			"5001",
			"/tmp/srtla_ips",
			"--conn-timeout-ms",
			"15000",
		]);
	});

	// The timeout is NOT an option a caller can forget or override: no input
	// shape removes it, so every spawn asserts the device value.
	test("buildSrtlaSendArgs_conn_timeout_is_unconditional", () => {
		const inputs = [
			{ srtlaHost: "host" },
			{ srtlaHost: "host", verbose: true },
			{ srtlaHost: "host", statsFile: "/p", statsFileInterval: 250 },
			{
				srtlaHost: "host",
				bindMap: "/m.json",
				noRehome: true,
				noStallDeselect: true,
			},
		];
		for (const input of inputs) {
			const args = buildSrtlaSendArgs(input);
			const idx = args.indexOf("--conn-timeout-ms");
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(args[idx + 1]).toBe("15000");
			expect(args.filter((arg) => arg === "--conn-timeout-ms")).toHaveLength(1);
		}
	});

	test("buildSrtlaSendArgs_verbose_only", () => {
		const args = buildSrtlaSendArgs({ srtlaHost: "host", verbose: true });
		expect(args).toEqual([
			"5000",
			"host",
			"5001",
			"/tmp/srtla_ips",
			"--conn-timeout-ms",
			"15000",
			"--verbose",
		]);
	});

	test("buildSrtlaSendArgs_stats_file_emitted", () => {
		const args = buildSrtlaSendArgs({
			srtlaHost: "host",
			statsFile: "/tmp/srtla-send-stats-5000.json",
		});
		const idx = args.indexOf("--stats-file");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("/tmp/srtla-send-stats-5000.json");
	});

	test("buildSrtlaSendArgs_stats_file_omitted_when_unset", () => {
		const args = buildSrtlaSendArgs({ srtlaHost: "host" });
		expect(args).not.toContain("--stats-file");
		expect(args).not.toContain("--stats-file-interval");
	});

	test("buildSrtlaSendArgs_stats_file_interval_emitted", () => {
		const args = buildSrtlaSendArgs({
			srtlaHost: "host",
			statsFile: "/p",
			statsFileInterval: 2000,
		});
		const idx = args.indexOf("--stats-file-interval");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("2000");
	});

	test("buildSrtlaSendArgs_stats_file_interval_stringified_after_stats_file", () => {
		const args = buildSrtlaSendArgs({
			srtlaHost: "host",
			statsFile: "/s",
			statsFileInterval: 500,
		});
		const intervalIdx = args.indexOf("--stats-file-interval");
		expect(intervalIdx).toBeGreaterThanOrEqual(0);
		expect(args[intervalIdx + 1]).toBe("500");
		expect(args.indexOf("--stats-file")).toBeLessThan(intervalIdx);
	});

	test("buildSrtlaSendArgs_control_socket_emitted", () => {
		const args = buildSrtlaSendArgs({
			srtlaHost: "host",
			controlSocket: "/tmp/srtla-send-control-5000.sock",
		});
		const idx = args.indexOf("--control-socket");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("/tmp/srtla-send-control-5000.sock");
	});

	// ADR-003: the bind map is ADDITIVE. Omitting it must leave the legacy
	// source-IP vector untouched, which is the whole point of the sidecar.
	test("buildSrtlaSendArgs_bind_map_omitted_when_unset", () => {
		expect(buildSrtlaSendArgs({ srtlaHost: "host" })).not.toContain(
			"--bind-map",
		);
	});

	test("buildSrtlaSendArgs_bind_map_emitted", () => {
		const args = buildSrtlaSendArgs({
			srtlaHost: "host",
			bindMap: "/run/srtla-bind-map.json",
		});
		const idx = args.indexOf("--bind-map");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("/run/srtla-bind-map.json");
	});

	// Upstream ships re-home and stall-deselect ON. The opt-outs exist so an
	// operator can turn either off WITHOUT the binding asserting a default of
	// its own — absent means "whatever the sender ships".
	test("buildSrtlaSendArgs_upstream_default_opt_outs_are_absent_by_default", () => {
		const args = buildSrtlaSendArgs({ srtlaHost: "host" });
		expect(args).not.toContain("--no-rehome");
		expect(args).not.toContain("--no-stall-deselect");
	});

	test("buildSrtlaSendArgs_no_rehome_emitted", () => {
		expect(buildSrtlaSendArgs({ srtlaHost: "host", noRehome: true })).toContain(
			"--no-rehome",
		);
	});

	test("buildSrtlaSendArgs_no_stall_deselect_emitted", () => {
		expect(
			buildSrtlaSendArgs({ srtlaHost: "host", noStallDeselect: true }),
		).toContain("--no-stall-deselect");
	});

	test("buildSrtlaSendArgs_false_opt_outs_emit_nothing", () => {
		const args = buildSrtlaSendArgs({
			srtlaHost: "host",
			noRehome: false,
			noStallDeselect: false,
		});
		expect(args).not.toContain("--no-rehome");
		expect(args).not.toContain("--no-stall-deselect");
	});
});

describe("buildCapabilitiesProbeArgs", () => {
	// The probe must be side-effect free: no positionals means the sender never
	// binds a socket, it only prints its capability document and exits 0.
	test("carries the probe flag and nothing else", () => {
		expect(buildCapabilitiesProbeArgs()).toEqual([CAPABILITIES_JSON_FLAG]);
		expect(CAPABILITIES_JSON_FLAG).toBe("--capabilities-json");
	});
});

describe("getSrtlaSendExec", () => {
	test("getSrtlaSendExec_appends_binary_for_absent_directory_path", () => {
		expect(getSrtlaSendExec("/nonexistent/srtla/dir")).toBe(
			"/nonexistent/srtla/dir/srtla_send",
		);
	});

	test("getSrtlaSendExec_returns_absent_path_already_ending_in_binary", () => {
		expect(getSrtlaSendExec("/nonexistent/srtla_send")).toBe(
			"/nonexistent/srtla_send",
		);
	});

	test("the packaged system path is the Debian install location", () => {
		expect(DEFAULT_SRTLA_SEND_PATH).toBe("/usr/bin/srtla_send");
	});
});

describe("spawnSrtlaSend", () => {
	test("spawnSrtlaSend_rejects_out_of_range_listen_port", () => {
		expect(() =>
			spawnSrtlaSend({ srtlaHost: "host", listenPort: 70000 }),
		).toThrow(ZodError);
	});

	test("spawnSrtlaSend_rejects_zero_srtla_port", () => {
		expect(() => spawnSrtlaSend({ srtlaHost: "host", srtlaPort: 0 })).toThrow(
			ZodError,
		);
	});
});
