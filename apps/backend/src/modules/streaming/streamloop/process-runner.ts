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

// Process supervision layer: owns the list of running stream subprocesses and
// the Bun.spawn lifecycle. This is the SOLE owner of the `streamingProcesses`
// state — every other module reaches it through the exported helpers so the
// mutable list never leaks across module boundaries.

import { logger } from "../../../helpers/logger.ts";
import { periodicCheckForSoftwareUpdates } from "../../system/software-updates.ts";
import {
	SHUTDOWN_SIGKILL_TIMEOUT_MS,
	SHUTDOWN_SIGTERM_GRACE_MS,
} from "../constants.ts";
import {
	broadcastHealthIfChanged,
	reportStreamProcessExit,
} from "../health.ts";
import { stopLinkTelemetry } from "../link-telemetry.ts";
import { updateStatus } from "../streaming.ts";

// Bun.Subprocess is not an EventEmitter, so the exit lifecycle is modeled here:
// `exitListeners` replaces .on("exit")/.removeAllListeners("exit") and fires once
// when `proc.exited` resolves; `spawnfile` replaces ChildProcess.spawnfile.
export type StreamingProcess = {
	proc: Bun.Subprocess<"inherit", "inherit", "pipe">;
	spawnfile: string;
	exitListeners: Array<() => void>;
};

let streamingProcesses: Array<StreamingProcess> = [];

// Live view of the supervised processes. Returned by reference so callers see
// removals as they happen; never reassigned by callers — mutation goes through
// the helpers below.
export function getStreamingProcesses(): Array<StreamingProcess> {
	return streamingProcesses;
}

export function spawnStreamingLoop(
	command: string,
	args: Array<string>,
	errCallback: (data: string) => void,
): StreamingProcess {
	const proc = Bun.spawn([command, ...args], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "pipe",
	});

	const streamingProcess: StreamingProcess = {
		proc,
		spawnfile: command,
		exitListeners: [],
	};
	streamingProcesses.push(streamingProcess);

	if (errCallback) {
		// Drain stderr by async iteration: chunks arrive in order, matching the
		// previous stderr.on("data") delivery. Each chunk is decoded on its own,
		// preserving the per-chunk pattern matching the errCallback relies on.
		(async () => {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stderr) {
				const dataStr = decoder.decode(chunk);
				logger.debug(`${streamingProcess.spawnfile} stderr: ${dataStr}`);
				errCallback(dataStr);
			}
		})().catch((err) => {
			// stderr is torn down when the process is killed; that surfaces here
			// as a benign cancellation, not a subprocess error to report.
			logger.debug(`${streamingProcess.spawnfile} stderr drain ended`, { err });
		});
	}

	// proc.exited resolves once; run whatever exit listeners are registered at
	// that moment (mirrors a one-shot EventEmitter "exit").
	proc.exited.then(() => {
		for (const listener of [...streamingProcess.exitListeners]) {
			listener();
		}
	});

	// ADR-0005: systemd is the SOLE process-restart authority. The app must
	// observe-and-notify only — it logs the exit and updates the health state,
	// but never respawns the process (that would create a dual restart authority
	// racing systemd's Restart=on-failure).
	streamingProcess.exitListeners.push(() => {
		const { exitCode, signalCode } = streamingProcess.proc;
		logger.warn(
			`streamloop: ${streamingProcess.spawnfile} exited (code=${
				exitCode ?? "null"
			}, signal=${
				signalCode ?? "null"
			}); not respawning — systemd owns process restart (ADR-0005)`,
		);
		// remove the dead process from the supervised list
		removeProc(streamingProcess);
		// srtla_send is the telemetry producer; its exit ends the stats stream.
		if (streamingProcess.spawnfile.endsWith("srtla_send")) {
			stopLinkTelemetry();
		}
		// notify health state: the stream is now dead until systemd respawns it
		reportStreamProcessExit();
		broadcastHealthIfChanged();
	});
	return streamingProcess;
}

function removeProc(streamingProcess: StreamingProcess) {
	streamingProcesses = streamingProcesses.filter((p) => p !== streamingProcess);
}

export function stopProcess(streamingProcess: StreamingProcess) {
	streamingProcess.exitListeners = [];
	streamingProcess.exitListeners.push(() => {
		removeProc(streamingProcess);
	});

	if (
		streamingProcess.proc.exitCode === null &&
		streamingProcess.proc.signalCode === null
	) {
		streamingProcess.proc.kill("SIGTERM");
		return false;
	}

	removeProc(streamingProcess);
	return true;
}

export async function stopProcessAndWait(
	streamingProcess: StreamingProcess,
): Promise<void> {
	if (stopProcess(streamingProcess)) return;
	let killTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
	try {
		await Promise.race([
			streamingProcess.proc.exited.then(() => undefined),
			new Promise<void>((resolve) => {
				killTimer = globalThis.setTimeout(() => {
					if (
						streamingProcess.proc.exitCode === null &&
						streamingProcess.proc.signalCode === null
					) {
						streamingProcess.proc.kill("SIGKILL");
					}
					resolve();
				}, SHUTDOWN_SIGKILL_TIMEOUT_MS);
			}),
		]);
		await streamingProcess.proc.exited;
	} finally {
		if (killTimer !== undefined) globalThis.clearTimeout(killTimer);
	}
}

const stopCheckInterval = 50;
let shutdownStartTime: number | null = null;

function waitForAllProcessesToTerminate() {
	if (streamingProcesses.length === 0) {
		logger.info("stop: all processes terminated");
		updateStatus(false);
		stopLinkTelemetry();
		shutdownStartTime = null;

		periodicCheckForSoftwareUpdates();
		return;
	}

	// Initialize shutdown timer on first call
	if (shutdownStartTime === null) {
		shutdownStartTime = Date.now();
	}

	const elapsedMs = Date.now() - shutdownStartTime;

	// If timeout exceeded, SIGKILL remaining processes
	if (elapsedMs >= SHUTDOWN_SIGKILL_TIMEOUT_MS) {
		const killedProcesses = [...streamingProcesses];
		for (const p of killedProcesses) {
			logger.warn(
				`stop: SIGKILL timeout (${SHUTDOWN_SIGKILL_TIMEOUT_MS}ms) exceeded for ${p.spawnfile}; sending SIGKILL`,
			);
			p.proc.kill("SIGKILL");
		}
		// Reset timer and continue polling for actual termination
		shutdownStartTime = Date.now();
	} else {
		for (const p of streamingProcesses) {
			logger.info(`stop: still waiting for ${p.spawnfile} to terminate...`);
		}
	}

	setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
}

export function stopAll() {
	for (const p of streamingProcesses) {
		stopProcess(p);
	}
	setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
}

type Timer = ReturnType<typeof globalThis.setTimeout>;

// Injectable so the SIGTERM→SIGKILL escalation is testable with no real wait.
export interface ShutdownTimers {
	setTimeout(fn: () => void, ms: number): Timer;
	clearTimeout(timer: Timer): void;
}

const realShutdownTimers: ShutdownTimers = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (timer) => {
		globalThis.clearTimeout(timer);
	},
};

function isProcAlive(sp: StreamingProcess): boolean {
	return sp.proc.exitCode === null && sp.proc.signalCode === null;
}

/**
 * Process-level graceful shutdown (systemd SIGTERM / SIGINT). SIGTERM every live
 * subprocess, resolve as soon as they have all exited, and SIGKILL any survivor
 * once `timeoutMs` elapses. Resolves either way so the caller can exit cleanly.
 *
 * Unlike {@link stopAll} (the in-app stream-stop poll), this is the short window
 * systemd grants before it kills CeraUI itself. The process list and timers are
 * injectable so the escalation is testable with zero real waits.
 */
export function gracefulShutdown(
	timeoutMs: number = SHUTDOWN_SIGTERM_GRACE_MS,
	procs: Array<StreamingProcess> = streamingProcesses,
	timers: ShutdownTimers = realShutdownTimers,
): Promise<void> {
	const remaining = new Set([...procs].filter(isProcAlive));
	if (remaining.size === 0) return Promise.resolve();

	return new Promise<void>((resolve) => {
		let settled = false;
		let killTimer: Timer | null = null;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			if (killTimer !== null) timers.clearTimeout(killTimer);
			resolve();
		};

		for (const sp of remaining) {
			sp.exitListeners.push(() => {
				removeProc(sp);
				remaining.delete(sp);
				if (remaining.size === 0) finish();
			});
			sp.proc.kill("SIGTERM");
		}

		killTimer = timers.setTimeout(() => {
			for (const sp of remaining) {
				if (!isProcAlive(sp)) continue;
				logger.warn(
					`gracefulShutdown: ${sp.spawnfile} ignored SIGTERM for ${timeoutMs}ms; sending SIGKILL`,
				);
				sp.proc.kill("SIGKILL");
			}
			finish();
		}, timeoutMs);
	});
}
