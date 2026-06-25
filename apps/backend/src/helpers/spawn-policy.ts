/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * SPAWN-POLICY REGISTRY (Standard S1).
 *
 * Every child-process site in the CeraUI backend is classified here into exactly
 * ONE of five spawn classes, and the per-class contract is declared as
 * machine-readable data. This registry is the single source of truth consumed by
 *   (1) the runtime helpers below (spawnWithTimeout / superviseWorker / spawnWatcher), and
 *   (2) the exec-guard gate (todo-16) which structurally enforces the contract.
 *
 * The FIVE classes and their contracts:
 *
 *  - bounded-command   one-shot side effect (apt-get, nmcli/systemctl one-shots,
 *                      addon-validate `sh -c`). MUST carry a wall-clock timeout
 *                      (via run() from helpers/run.ts, or spawnWithTimeout). NOT
 *                      lifetime-exempt. The single exception is a streamed
 *                      long-runner (apt-get progress) that is maxBuffer-bounded
 *                      but legitimately has no wall-clock cap — flagged
 *                      `streamingExempt`.
 *  - bounded-probe     read-only / quick probe (killall, version probes). MUST be
 *                      timed; allowlisted where applicable.
 *  - supervised-worker media-path process that runs for the stream's lifetime
 *                      (srtla_send, bcrpt, srt ingest). Carries a startup /
 *                      readiness timeout + shutdown cleanup, and is EXEMPT from a
 *                      process-lifetime timeout — a lifetime timeout would kill
 *                      the live stream.
 *  - watcher           intentionally never returns (nmcli monitor, dmesg -w).
 *                      EXEMPT from any timeout; MUST register a shutdown-abort so
 *                      the child dies with the supervisor, not orphaned.
 *  - terminal-spawnSync synchronous, terminal by design (reboot/poweroff,
 *                      self-fencing reboot). No timeout, no supervision — the host
 *                      is going down.
 *
 * INVARIANTS THIS FILE LOCKS IN:
 *  - cerastream is NOT in this registry — it is systemd-owned and IPC-driven
 *    (ADR-0005), never spawned by the backend.
 *  - srtla_send + the streamloop are observe-and-notify ONLY: systemd is the SOLE
 *    restart authority (process-runner.ts). The app never respawns them.
 *  - bcrpt is the ONE supervised-worker with app-level restart + bounded backoff.
 *  - supervised-workers must NEVER be given a process-lifetime timeout.
 */

import { logger } from "./logger.ts";

/** The five spawn classes. Every spawn site is exactly one of these. */
export type SpawnClass =
	| "bounded-command"
	| "bounded-probe"
	| "supervised-worker"
	| "watcher"
	| "terminal-spawnSync";

/**
 * Wiring status of a site against its declared contract.
 *  - enforced: the live site already meets the contract.
 *  - partial:  the mechanism exists but is not yet fully wired (audit flag).
 *  - pending:  the contract is declared; live wiring is scheduled separately.
 */
export type SpawnSiteStatus = "enforced" | "partial" | "pending";

/** The per-class contract a site must honour, expressed as machine-readable flags. */
export interface SpawnSiteContract {
	/** Wall-clock timeout enforced (bounded-* MUST be true unless streamingExempt). */
	readonly timed: boolean;
	/** Startup / readiness timeout (supervised-worker only). */
	readonly startupTimeout: boolean;
	/** Killed/cleaned up at shutdown (supervised-worker). */
	readonly shutdownCleanup: boolean;
	/** Shutdown-abort registered so the child dies with the supervisor (watcher). */
	readonly shutdownAbort: boolean;
	/** Exempt from a process-lifetime timeout (supervised-worker + watcher MUST be true). */
	readonly lifetimeTimeoutExempt: boolean;
	/** Streamed long-runner: maxBuffer-bounded but no wall-clock cap (apt-get only). */
	readonly streamingExempt?: boolean;
}

/** One classified spawn site. */
export interface SpawnSite {
	/** Stable identifier (used by the exec-guard gate + tests). */
	readonly id: string;
	/** Source file, relative to apps/backend/src. */
	readonly file: string;
	/** Function / symbol that owns the spawn. */
	readonly symbol: string;
	/** The binary or command shape. */
	readonly command: string;
	readonly class: SpawnClass;
	readonly contract: SpawnSiteContract;
	readonly status: SpawnSiteStatus;
	/** How the contract is (or will be) honoured at the live site. */
	readonly mechanism: string;
}

/**
 * THE REGISTRY — all 15 production spawn sites (T1 inventory). Test-only spawns
 * are excluded by design. `cerastream` is excluded: it is IPC-driven, not spawned.
 */
export const SPAWN_POLICY: readonly SpawnSite[] = [
	{
		id: "exec.execFileP",
		file: "helpers/exec.ts",
		symbol: "execFileP",
		command: "[file, ...args] (argv-only foundation)",
		class: "bounded-command",
		contract: {
			timed: true,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: false,
			lifetimeTimeoutExempt: false,
		},
		status: "enforced",
		mechanism:
			"wall-clock timeout (DEFAULT_SPAWN_TIMEOUT_MS) kills the child + maxBuffer overflow kill",
	},
	{
		id: "run.spawnCollect",
		file: "helpers/run.ts",
		symbol: "spawnCollect (run / runWithStdin)",
		command: "[bin, ...args] (allowlisted, argv-only)",
		class: "bounded-command",
		contract: {
			timed: true,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: false,
			lifetimeTimeoutExempt: false,
		},
		status: "enforced",
		mechanism:
			"DEFAULT_TIMEOUT_MS + AbortSignal → RunTimeoutError/RunAbortError (T6)",
	},
	{
		id: "killall.spawnSync",
		file: "helpers/killall.ts",
		symbol: "killall (non-allowlisted fallback)",
		command: "[killallBinary, ...args] (spawnSync)",
		class: "bounded-probe",
		contract: {
			timed: true,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: false,
			lifetimeTimeoutExempt: false,
		},
		status: "enforced",
		mechanism:
			"allowlisted path uses run() (timed); the spawnSync fallback carries a Bun.spawnSync timeout",
	},
	{
		id: "wifi.nmcliNew",
		file: "modules/wifi/wifi.ts",
		symbol: "runWifiNew",
		command: "[nmcli, ...args]",
		class: "bounded-command",
		contract: {
			timed: true,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: false,
			lifetimeTimeoutExempt: false,
		},
		status: "enforced",
		mechanism: "Bun.spawn timeout option kills a hung nmcli connect",
	},
	{
		id: "monitor.nmcliMonitor",
		file: "modules/network/monitor/monitor-manager.ts",
		symbol: "spawnNmcliMonitor / NmcliMonitorManager",
		command: "[nmcli, monitor]",
		class: "watcher",
		contract: {
			timed: false,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: true,
			lifetimeTimeoutExempt: true,
		},
		status: "enforced",
		mechanism:
			"NmcliMonitorManager.stop() kills the child; restart loop is bounded-backoff supervised",
	},
	{
		id: "system.power",
		file: "rpc/procedures/system.procedure.ts",
		symbol: "defaultPowerCommandRunner",
		command: "[poweroff|reboot] (spawnSync)",
		class: "terminal-spawnSync",
		contract: {
			timed: false,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: false,
			lifetimeTimeoutExempt: false,
		},
		status: "enforced",
		mechanism: "synchronous host power-down; terminal by design",
	},
	{
		id: "streamloop.srtlaSend",
		file: "modules/streaming/streamloop/process-runner.ts",
		symbol: "spawnStreamingLoop",
		command: "[command, ...args] (e.g. srtla_send)",
		class: "supervised-worker",
		contract: {
			timed: false,
			startupTimeout: true,
			shutdownCleanup: true,
			shutdownAbort: false,
			lifetimeTimeoutExempt: true,
		},
		status: "enforced",
		mechanism:
			"startStream readiness gate; stopAll()/gracefulShutdown() SIGTERM→SIGKILL. systemd is the SOLE restart authority (ADR-0005) — never respawned by the app",
	},
	{
		id: "streaming.bcrpt",
		file: "modules/streaming/bcrpt.ts",
		symbol: "startBcrpt",
		command: "[bcrptExec, ...args]",
		class: "supervised-worker",
		contract: {
			timed: false,
			startupTimeout: true,
			shutdownCleanup: true,
			shutdownAbort: false,
			lifetimeTimeoutExempt: true,
		},
		status: "enforced",
		mechanism:
			"config-generation gate before spawn; SIGHUP reload + exit handler. The ONE site with app-level restart + bounded backoff (MAX_BCRPT_RETRIES)",
	},
	{
		id: "ingest.srtLiveTransmit",
		file: "modules/ingest/srt.ts",
		symbol: "startSrtTransmitter",
		command: "[srt-live-transmit, ...]",
		class: "supervised-worker",
		contract: {
			timed: false,
			startupTimeout: true,
			shutdownCleanup: true,
			shutdownAbort: false,
			lifetimeTimeoutExempt: true,
		},
		status: "pending",
		mechanism:
			"long-lived SRT→UDP relay; readiness inferred from stderr 'Accepted SRT source connection'. Shutdown-cleanup wiring scheduled (superviseWorker adoption)",
	},
	{
		id: "selfFencing.spawnOp",
		file: "modules/remote-control/self-fencing.ts",
		symbol: "spawnOp",
		command: "argv (spawnSync, non-revertible e.g. reboot)",
		class: "terminal-spawnSync",
		contract: {
			timed: false,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: false,
			lifetimeTimeoutExempt: false,
		},
		status: "enforced",
		mechanism:
			"synchronous non-revertible op, gated behind self_fencing.confirm; terminal by design",
	},
	{
		id: "sensors.dmesgJetson",
		file: "modules/system/sensors.ts",
		symbol: "initSensors (jetson dmesg -w)",
		command: "[dmesg, -w]",
		class: "watcher",
		contract: {
			timed: false,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: true,
			lifetimeTimeoutExempt: true,
		},
		status: "pending",
		mechanism:
			"kernel-log undervoltage watcher; shutdown-abort wiring scheduled (spawnWatcher adoption)",
	},
	{
		id: "sensors.dmesgRk3588",
		file: "modules/system/sensors.ts",
		symbol: "initSensors (rk3588 dmesg -w)",
		command: "[dmesg, -w]",
		class: "watcher",
		contract: {
			timed: false,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: true,
			lifetimeTimeoutExempt: true,
		},
		status: "pending",
		mechanism:
			"kernel-log HDMI watcher; shutdown-abort wiring scheduled (spawnWatcher adoption)",
	},
	{
		id: "softwareUpdates.aptGet",
		file: "modules/system/software-updates.ts",
		symbol: "doSoftwareUpdate",
		command: "[apt-get, ...upgradeArgs]",
		class: "bounded-command",
		contract: {
			timed: false,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: false,
			lifetimeTimeoutExempt: false,
			streamingExempt: true,
		},
		status: "enforced",
		mechanism:
			"streams stdout to parse + broadcast apt progress; a wall-clock cap is wrong (an upgrade legitimately runs minutes). Bounded by output parsing, not time",
	},
	{
		id: "addons.runValidateCmd",
		file: "modules/addons/manager.ts",
		symbol: "runValidateCmd",
		command: "[sh, -c, cmd] (GPG-signed descriptor)",
		class: "bounded-probe",
		contract: {
			timed: true,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: false,
			lifetimeTimeoutExempt: false,
		},
		status: "enforced",
		mechanism:
			"setTimeout → proc.kill() hard wall-clock timeout → false (compliant exemplar)",
	},
	{
		id: "revisions.readRevision",
		file: "modules/system/revisions.ts",
		symbol: "readRevision",
		command: "cmd.split(' ') (spawnSync, version probes)",
		class: "bounded-probe",
		contract: {
			timed: true,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: false,
			lifetimeTimeoutExempt: false,
		},
		status: "enforced",
		mechanism:
			"git rev-parse / `<exec> -v` quick probes; Bun.spawnSync timeout caps a hung probe → 'unknown revision'",
	},
] as const;

/**
 * Validate a single site's DECLARED contract against its class invariants.
 * Returns a list of human-readable violations (empty == compliant). This is the
 * structural check the exec-guard gate (todo-16) runs over the registry.
 */
export function validateSpawnSite(site: SpawnSite): string[] {
	const errs: string[] = [];
	const c = site.contract;
	const push = (m: string) => errs.push(`${site.id}: ${m}`);

	switch (site.class) {
		case "bounded-command":
		case "bounded-probe":
			if (!c.timed && !c.streamingExempt) {
				push(`${site.class} must be timed (or explicitly streamingExempt)`);
			}
			if (c.lifetimeTimeoutExempt) {
				push(`${site.class} must NOT be lifetime-timeout-exempt`);
			}
			if (c.startupTimeout || c.shutdownCleanup || c.shutdownAbort) {
				push("bounded site must not carry supervision flags");
			}
			break;
		case "supervised-worker":
			if (c.timed) {
				push("supervised-worker must NOT carry a process-lifetime timeout");
			}
			if (!c.lifetimeTimeoutExempt) {
				push("supervised-worker must be lifetime-timeout-exempt");
			}
			if (!c.startupTimeout) {
				push("supervised-worker must declare a startup/readiness timeout");
			}
			if (!c.shutdownCleanup) {
				push("supervised-worker must declare shutdown cleanup");
			}
			break;
		case "watcher":
			if (c.timed) push("watcher must NOT carry a timeout");
			if (!c.lifetimeTimeoutExempt) {
				push("watcher must be lifetime-timeout-exempt");
			}
			if (!c.shutdownAbort) push("watcher must register a shutdown-abort");
			break;
		case "terminal-spawnSync":
			if (
				c.timed ||
				c.startupTimeout ||
				c.shutdownCleanup ||
				c.shutdownAbort ||
				c.lifetimeTimeoutExempt
			) {
				push("terminal-spawnSync must carry no timeout/supervision contract");
			}
			break;
	}
	return errs;
}

/**
 * Assert the WHOLE registry is contract-consistent. Throws with every violation
 * if any site's declared contract breaks its class invariants. Also enforces
 * unique ids. Called by the registry self-consistency test and (todo-16) the gate.
 */
export function assertSpawnPolicyConsistent(
	registry: readonly SpawnSite[] = SPAWN_POLICY,
): void {
	const errs = registry.flatMap(validateSpawnSite);
	const seen = new Set<string>();
	for (const site of registry) {
		if (seen.has(site.id)) errs.push(`duplicate site id: ${site.id}`);
		seen.add(site.id);
	}
	if (errs.length > 0) {
		throw new Error(`spawn-policy contract violations:\n${errs.join("\n")}`);
	}
}

/** Look up a site's policy by id (the exec-guard gate keys spawns to this). */
export function getSpawnSite(id: string): SpawnSite | undefined {
	return SPAWN_POLICY.find((s) => s.id === id);
}

// ─── Runtime helpers — the per-class enforcement mechanisms ───────────────────

/** Default wall-clock budget for a bounded one-shot spawn: 30 s. */
export const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;

/** Default startup/readiness budget for a supervised worker: 15 s. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

/** Default grace before SIGKILL escalates after SIGTERM at shutdown: 5 s. */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** Rejection raised when a {@link spawnWithTimeout} child exceeds its budget. */
export class SpawnTimeoutError extends Error {
	constructor(
		public readonly command: string,
		public readonly partialStdout: string = "",
		public readonly partialStderr: string = "",
	) {
		super(`Spawn timed out: ${command}`);
		this.name = "SpawnTimeoutError";
	}
}

/** Rejection raised when a supervised worker fails to become ready in time. */
export class StartupTimeoutError extends Error {
	constructor(public readonly command: string) {
		super(`Worker did not become ready in time: ${command}`);
		this.name = "StartupTimeoutError";
	}
}

export interface SpawnWithTimeoutResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * bounded-command / bounded-probe enforcement: spawn `argv` argv-only with a HARD
 * wall-clock timeout. On timeout the child is killed and the call rejects with
 * {@link SpawnTimeoutError}, preserving whatever output arrived. Use this for any
 * bounded one-shot that cannot route through allowlisted run() (e.g. `sh -c`).
 */
export async function spawnWithTimeout(
	argv: string[],
	opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<SpawnWithTimeoutResult> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
	const command = argv.join(" ");
	if (opts?.signal?.aborted) {
		throw new SpawnTimeoutError(command);
	}

	const child = Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const kill = () => {
		try {
			child.kill();
		} catch {
			// best-effort: the process may have already exited
		}
	};

	const acc = { stdout: "", stderr: "" };
	const drain = async (
		stream: ReadableStream<Uint8Array> | undefined,
		key: "stdout" | "stderr",
	): Promise<void> => {
		if (!stream) return;
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			acc[key] += decoder.decode(chunk, { stream: true });
		}
		acc[key] += decoder.decode();
	};
	const stdoutDone = drain(child.stdout, "stdout");
	const stderrDone = drain(child.stderr, "stderr");

	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const outcome = await new Promise<"exit" | "timeout" | "abort">(
			(resolve) => {
				void child.exited.then(() => resolve("exit"));
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
				if (opts?.signal) {
					onAbort = () => resolve("abort");
					opts.signal.addEventListener("abort", onAbort, { once: true });
				}
			},
		);

		if (outcome !== "exit") {
			kill();
			await Promise.allSettled([stdoutDone, stderrDone, child.exited]);
			throw new SpawnTimeoutError(command, acc.stdout, acc.stderr);
		}

		await Promise.allSettled([stdoutDone, stderrDone]);
		return {
			exitCode: child.exitCode ?? 0,
			stdout: acc.stdout,
			stderr: acc.stderr,
		};
	} finally {
		if (timer) clearTimeout(timer);
		if (opts?.signal && onAbort) {
			opts.signal.removeEventListener("abort", onAbort);
		}
	}
}

/** Minimal Subprocess shape a supervised worker / watcher depends on. */
export interface ManagedProcess {
	readonly exited: Promise<number>;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals | number): void;
}

export interface SuperviseOptions {
	/** Max ms to wait for readiness before failing startup. */
	readonly startupTimeoutMs?: number;
	/** Resolves when the worker is ready; rejects/throws → startup failure. */
	readonly waitForReady?: (proc: ManagedProcess) => Promise<void>;
	/** Graceful-stop signal sent first at shutdown (default SIGTERM). */
	readonly killSignal?: NodeJS.Signals;
	/** Grace before SIGKILL escalates after the graceful signal. */
	readonly killGraceMs?: number;
	/** Spawn override (tests inject a fake child). */
	readonly spawn?: (argv: string[]) => ManagedProcess;
}

export interface SupervisedHandle {
	readonly proc: ManagedProcess;
	/** Resolves on readiness; rejects with {@link StartupTimeoutError} on timeout. */
	readonly ready: Promise<void>;
	/** Idempotent SIGTERM→SIGKILL shutdown cleanup. Resolves once the child exits. */
	shutdown(): Promise<void>;
}

/**
 * supervised-worker enforcement: spawn a media-path worker with a startup /
 * readiness timeout and a shutdown-cleanup hook — and CRUCIALLY no
 * process-lifetime timeout (a lifetime cap would kill the live stream). The only
 * timer here governs READINESS; once ready (or once that timer clears) nothing
 * ever kills the worker except an explicit {@link SupervisedHandle.shutdown}.
 */
export function superviseWorker(
	argv: string[],
	opts?: SuperviseOptions,
): SupervisedHandle {
	const command = argv.join(" ");
	const proc: ManagedProcess = opts?.spawn
		? opts.spawn(argv)
		: (Bun.spawn(argv, {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}) as unknown as ManagedProcess);

	const startupTimeoutMs = opts?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
	const waitForReady = opts?.waitForReady ?? (() => Promise.resolve());

	const ready = new Promise<void>((resolve, reject) => {
		let settled = false;
		const startupTimer = setTimeout(() => {
			if (settled) return;
			settled = true;
			// Startup readiness failed — the worker never came up. This is NOT a
			// lifetime timeout: it never kills an already-ready worker.
			reject(new StartupTimeoutError(command));
		}, startupTimeoutMs);

		waitForReady(proc).then(
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(startupTimer);
				resolve();
			},
			(err) => {
				if (settled) return;
				settled = true;
				clearTimeout(startupTimer);
				reject(err);
			},
		);
	});
	// A rejected readiness must not surface as an unhandled rejection if the
	// caller only ever calls shutdown().
	ready.catch(() => {
		// readiness errors surface to the caller via shutdown(), not here
	});

	const alive = () => proc.exitCode === null && proc.signalCode === null;
	let shutdownPromise: Promise<void> | undefined;

	const shutdown = (): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			if (!alive()) return;
			proc.kill(opts?.killSignal ?? "SIGTERM");
			const grace = opts?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
			const escalation = new Promise<void>((resolve) => {
				const t = setTimeout(() => {
					if (alive()) {
						logger.warn(
							`superviseWorker: ${command} ignored SIGTERM for ${grace}ms; sending SIGKILL`,
						);
						try {
							proc.kill("SIGKILL");
						} catch {
							// best-effort: the process may have already exited
						}
					}
					resolve();
				}, grace);
				void proc.exited.then(() => {
					clearTimeout(t);
					resolve();
				});
			});
			await escalation;
			await proc.exited.catch(() => undefined);
		})();
		return shutdownPromise;
	};

	return { proc, ready, shutdown };
}

export interface WatcherOptions {
	/** Aborting this signal kills the watcher (the shutdown-abort). */
	readonly signal?: AbortSignal;
	/** Signal used to kill the watcher (default SIGTERM). */
	readonly killSignal?: NodeJS.Signals;
	/** Spawn override (tests inject a fake child). */
	readonly spawn?: (argv: string[]) => ManagedProcess;
}

export interface WatcherHandle {
	readonly proc: ManagedProcess;
	/** Kill the watcher (idempotent). Wired to the shutdown signal. */
	abort(): void;
}

/**
 * watcher enforcement: spawn an intentionally-never-returning child (nmcli
 * monitor, dmesg -w) with NO timeout, and register a shutdown-abort so the child
 * dies with the supervisor instead of being orphaned. The abort fires either via
 * the supplied {@link AbortSignal} or the returned {@link WatcherHandle.abort}.
 */
export function spawnWatcher(
	argv: string[],
	opts?: WatcherOptions,
): WatcherHandle {
	const command = argv.join(" ");
	const proc: ManagedProcess = opts?.spawn
		? opts.spawn(argv)
		: (Bun.spawn(argv, {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}) as unknown as ManagedProcess);

	const abort = (): void => {
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		try {
			proc.kill(opts?.killSignal ?? "SIGTERM");
		} catch (err) {
			logger.debug(`spawnWatcher: kill failed for ${command}: ${String(err)}`);
		}
	};

	if (opts?.signal) {
		if (opts.signal.aborted) {
			abort();
		} else {
			opts.signal.addEventListener("abort", abort, { once: true });
		}
	}

	return { proc, abort };
}
