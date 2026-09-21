// Sender CLI args, validation, and process helpers for the srtla sender.
//
// Absorbed from the retired npm sender binding (plan upstream-rebase-hard-fork,
// D13): the binding is no longer published, it lives here as a private
// workspace package consumed by `apps/backend` through
// `"@ceraui/srtla-send": "workspace:*"`. Export names are unchanged from the
// published package so the absorption is a mechanical import-source swap.
//
// This layer is Bun-native (Bun.spawn / Bun.which), not node:child_process.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

const DEFAULT_BINARY = "srtla_send";

/** Where the `srtla` Debian package installs the sender. */
export const DEFAULT_SRTLA_SEND_PATH = "/usr/bin/srtla_send";

/**
 * Link-liveness timeout handed to the sender on EVERY spawn, milliseconds.
 *
 * The hard-forked sender inherits upstream's `CONN_TIMEOUT = 5` s. CeraLive
 * needs 15 s — the value the bonding receiver (`srtla_rec`) holds a link for
 * while it keeps echoing keepalives. A sender that gives up at 5 s falsely
 * re-registers and resets the window on a link that is merely mid radio-stall.
 *
 * The sender's own constant is deliberately NOT patched (zero Rust divergence
 * from upstream); the device value is asserted here, on the command line, via
 * upstream's `--conn-timeout-ms` flag (clamped 1000..=60000 by the sender).
 * {@link buildSrtlaSendArgs} therefore emits it unconditionally — it is not an
 * option a caller can forget.
 */
export const CONN_TIMEOUT_MS = 15_000;

/**
 * The one-shot capability-probe flag (ADR-003 §7).
 *
 * Spawning the sender with ONLY this flag prints a single-line JSON capability
 * document and exits `0`. A build that does not understand it exits non-zero
 * with a usage error, which is itself the "no support" answer — callers must
 * treat ANY non-zero exit, unparseable output, or timeout as NO SUPPORT and
 * fall back to a legacy spawn.
 */
export const CAPABILITIES_JSON_FLAG = "--capabilities-json";

export const srtlaSendOptionsSchema = z.object({
	listenPort: z
		.number()
		.int()
		.min(1)
		.max(65535)
		.default(5000)
		.describe(
			"Local UDP port the sender listens on for SRT packets (positional arg 1).",
		),
	srtlaHost: z
		.string()
		.min(1)
		.describe(
			"Hostname or IP of the SRTLA receiver / srtla_rec (positional arg 2).",
		),
	srtlaPort: z
		.number()
		.int()
		.min(1)
		.max(65535)
		.default(5001)
		.describe("UDP port of the SRTLA receiver (positional arg 3)."),
	ipsFile: z
		.string()
		.min(1)
		.default("/tmp/srtla_ips")
		.describe(
			"Path to the newline-separated local source-IP (uplink) list (positional arg 4).",
		),
	verbose: z.boolean().optional(),
	statsFile: z.string().min(1).optional(),
	statsFileInterval: z.number().int().min(1).optional(),
	controlSocket: z
		.string()
		.optional()
		.describe(
			"Unix socket path for the JSON-RPC control channel. " +
				"Defaults to /tmp/srtla-send-control-<listenPort>.sock when omitted.",
		),
	bindMap: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Path to the ADR-003 bind-map sidecar. Additive and never required: " +
				"omitting it leaves the sender on the legacy source-IP bind path.",
		),
	noRehome: z
		.boolean()
		.optional()
		.describe(
			"Disable upstream whole-bond receiver re-homing, which is ON by default " +
				"in the hard-forked sender. Emits --no-rehome.",
		),
	noStallDeselect: z
		.boolean()
		.optional()
		.describe(
			"Disable upstream stall-deselect, which is ON by default in the " +
				"hard-forked sender. Emits --no-stall-deselect.",
		),
	execPath: z.string().optional(),
});

export type SrtlaSendOptionsInput = z.input<typeof srtlaSendOptionsSchema>;
export type SrtlaSendOptions = z.output<typeof srtlaSendOptionsSchema>;

// Positional order is the load-bearing parity contract: the four positionals
// MUST emit as <listen_port> <srtla_host> <srtla_port> <ips_file>, then flags.
// `--conn-timeout-ms` leads the flags because it is unconditional; every other
// flag is opt-in and appends after it.
export function buildSrtlaSendArgs(
	input: SrtlaSendOptionsInput,
): Array<string> {
	const options = srtlaSendOptionsSchema.parse(input);
	const args: Array<string> = [
		String(options.listenPort),
		options.srtlaHost,
		String(options.srtlaPort),
		options.ipsFile,
		"--conn-timeout-ms",
		String(CONN_TIMEOUT_MS),
	];
	if (options.verbose) {
		args.push("--verbose");
	}
	if (options.statsFile) {
		args.push("--stats-file", options.statsFile);
	}
	if (options.statsFileInterval !== undefined) {
		args.push("--stats-file-interval", String(options.statsFileInterval));
	}
	if (options.controlSocket) {
		args.push("--control-socket", options.controlSocket);
	}
	if (options.bindMap) {
		args.push("--bind-map", options.bindMap);
	}
	if (options.noRehome) {
		args.push("--no-rehome");
	}
	if (options.noStallDeselect) {
		args.push("--no-stall-deselect");
	}
	return args;
}

/**
 * The argv for the one-shot pre-spawn capability probe.
 *
 * Deliberately carries NO other argument: the probe must be side-effect free,
 * so it never receives the positionals that would make the sender bind a socket.
 */
export function buildCapabilitiesProbeArgs(): Array<string> {
	return [CAPABILITIES_JSON_FLAG];
}

/** Default control socket path for a given listen port. */
export function controlSocketPath(listenPort: number): string {
	return `/tmp/srtla-send-control-${listenPort}.sock`;
}

export function getSrtlaSendExec(execPath?: string): string {
	if (execPath) {
		const stat = existsSync(execPath) ? statSync(execPath) : undefined;
		if (stat?.isFile()) {
			return execPath;
		}
		if (stat?.isDirectory()) {
			return join(execPath, DEFAULT_BINARY);
		}
		return execPath.endsWith(DEFAULT_BINARY)
			? execPath
			: join(execPath, DEFAULT_BINARY);
	}

	const onPath = Bun.which(DEFAULT_BINARY);
	if (onPath) {
		return onPath;
	}
	if (existsSync(DEFAULT_SRTLA_SEND_PATH)) {
		return DEFAULT_SRTLA_SEND_PATH;
	}
	return DEFAULT_BINARY;
}

/**
 * Validate `options`, resolve the `srtla_send` binary, and spawn it with the
 * parity-locked positional argument vector.
 *
 * Throws a `ZodError` if `options` fails validation (e.g. an out-of-range port)
 * before any process is spawned. The binary is resolved via
 * {@link getSrtlaSendExec} (`options.execPath` → `PATH` → `/usr/bin/srtla_send`).
 *
 * @param options Sender options; the four positionals plus optional control-plane flags.
 * @returns The spawned `Bun.Subprocess`. The caller owns its lifecycle.
 */
export function spawnSrtlaSend(options: SrtlaSendOptionsInput): Bun.Subprocess {
	const parsed = srtlaSendOptionsSchema.parse(options);
	const exec = getSrtlaSendExec(parsed.execPath);
	const args = buildSrtlaSendArgs(parsed);
	return Bun.spawn([exec, ...args]);
}

/**
 * Signal every running `srtla_send` to reload its IP list (Unix `SIGHUP`).
 *
 * Mirrors the sender's live IP-list reload contract: surviving uplinks keep their
 * sockets, the pool is rebuilt in ips-file order. `killall` exits non-zero when no
 * process matches; that is treated as an acceptable no-op, so this never throws on
 * "nothing running".
 */
export function sendSrtlaSendHup(): void {
	// killall exits non-zero when no process matches; that is an acceptable no-op.
	Bun.spawnSync(["killall", "-HUP", DEFAULT_BINARY]);
}

export function isSrtlaSendRunning(): boolean {
	const result = Bun.spawnSync(["pgrep", "-x", DEFAULT_BINARY]);
	return result.exitCode === 0;
}
