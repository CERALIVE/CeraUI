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
) {
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
		})().catch(() => {
			// stderr is torn down when the process is killed; that surfaces here
			// as a benign cancellation, not a subprocess error to report.
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

const stopCheckInterval = 50;

function waitForAllProcessesToTerminate() {
	if (streamingProcesses.length === 0) {
		logger.info("stop: all processes terminated");
		updateStatus(false);
		stopLinkTelemetry();

		periodicCheckForSoftwareUpdates();
	} else {
		for (const p of streamingProcesses) {
			logger.info(`stop: still waiting for ${p.spawnfile} to terminate...`);
		}
		setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
	}
}

export function stopAll() {
	for (const p of streamingProcesses) {
		stopProcess(p);
	}
	setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
}
