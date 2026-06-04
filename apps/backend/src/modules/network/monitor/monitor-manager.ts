/*
    CeraUI - web UI for the CeraLive project
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
  Real subprocess monitor manager (T12).

  Spawns the GLOBAL `nmcli monitor` (NOT `nmcli device monitor`, which
  terminates when its target device disappears — see MONITOR-NOTES.md §a),
  streams its stdout line-by-line via the Bun.spawn async iterable (proven in
  the T8 spike), parses each line into a canonical `MonitorEvent`
  (state-types.ts), and emits it through the shared `IMonitorEmitter` contract.

  The `nmcli monitor` line text is HUMAN-READABLE — it is a TRIGGER, not a data
  source. Consumers react to an event by re-querying authoritative state. Events
  are keyed by DEVICE NAME (ifname), the only key the monitor emits.

  Death detection / restart: `proc.exited` resolving means the child died. We
  respawn it under `retryWithBackoff` (capped ≤2s between restarts) and, on each
  restart, invoke `onResync()` so callers can re-poll the current state (the
  monitor only reports events that occur AFTER it starts — no historical
  replay, so a gap must be reconciled by a full poll).

  Selection: `createMonitorManager(onResync)` returns this real manager in
  production, or the scripted `MockMonitorEmitter` when `shouldUseMockMonitor()`
  (MOCK_SCENARIO set or NODE_ENV=test) — so dev/test never invoke real nmcli.
*/

import { logger } from "../../../helpers/logger.ts";
import { retryWithBackoff } from "../../../helpers/retry.ts";
import type { IMonitorEmitter, MonitorEvent } from "../state-types.ts";
import { MockMonitorEmitter, shouldUseMockMonitor } from "./mock-monitor.ts";

/** Listener invoked for every emitted {@link MonitorEvent}. */
export type MonitorEventListener = (event: MonitorEvent) => void;

/**
 * Invoked once per restart of the underlying `nmcli monitor` child. The monitor
 * has no historical replay, so callers MUST re-poll authoritative state to
 * close the gap created while the child was down.
 */
export type ResyncCallback = () => void;

/**
 * Minimal shape of the long-lived monitor child process this manager drives.
 * Mirrors the subset of Bun's `Subprocess` we depend on, so tests can inject a
 * fake without spawning a real binary.
 */
export interface MonitorProcess {
	stdout: AsyncIterable<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number): void;
}

/** Factory that spawns a fresh monitor child. Injectable for tests. */
export type SpawnMonitor = () => MonitorProcess;

const NMCLI = "nmcli";
const NMCLI_MONITOR_ARGS = ["monitor"] as const;

// Restart backoff: effectively unbounded attempts (a long-lived supervisor),
// 100ms base growing exponentially but capped at 2s between restarts.
const RESTART_BACKOFF = {
	maxAttempts: Number.MAX_SAFE_INTEGER,
	baseDelayMs: 100,
	maxDelayMs: 2000,
} as const;

const GLOBAL_LINE_PREFIXES = ["NetworkManager", "Connectivity"] as const;

/**
 * Parse a single `nmcli monitor` stdout line into a canonical
 * {@link MonitorEvent}, or `null` for global/unrecognised lines (which callers
 * should log and skip — they are not state transitions we key on).
 *
 * Line shapes (see MONITOR-NOTES.md §a / fixtures/network/nmcli-monitor-events.txt):
 *   - device:     `"<ifname>: <state>"`              → device-state
 *   - device:     `"<ifname>: connected to '<conn>'"` → device-state (state before " to ")
 *   - connection: `"\"<conn>\" (<type>, <ip>): connection activated"` → connection-state
 *   - global:     `"NetworkManager is now in the '<state>' state"` / `"Connectivity is now '<state>'"` → null
 */
export function parseMonitorLine(line: string): MonitorEvent | null {
	const trimmed = line.trim();
	if (trimmed.length === 0) return null;

	// Connection-activity lines start with a quoted connection name.
	if (trimmed.startsWith('"')) {
		const match = trimmed.match(
			/^"([^"]*)"\s*\([^)]*\)\s*:\s*connection\s+(\S+)/,
		);
		if (match?.[1] !== undefined && match[2] !== undefined) {
			return {
				type: "connection-state",
				connection: match[1],
				state: match[2],
			};
		}
		// Malformed / unrecognised connection line — skip.
		return null;
	}

	// Global NM / connectivity lines carry no device key — skip.
	for (const prefix of GLOBAL_LINE_PREFIXES) {
		if (trimmed.startsWith(prefix)) return null;
	}

	// Device lines: "<ifname>: <state…>". Split on the FIRST ": ".
	const sep = trimmed.indexOf(": ");
	if (sep === -1) return null;

	const device = trimmed.slice(0, sep).trim();
	let state = trimmed.slice(sep + 2).trim();
	if (device.length === 0 || state.length === 0) return null;

	// "connected to '<conn>'" → keep the leading state word(s) before " to ".
	const toIdx = state.indexOf(" to ");
	if (toIdx !== -1) {
		state = state.slice(0, toIdx).trim();
	}

	// "connecting (getting IP configuration)" → strip the parenthetical phase.
	const parenIdx = state.indexOf(" (");
	if (parenIdx !== -1) {
		state = state.slice(0, parenIdx).trim();
	}

	if (state.length === 0) return null;
	return { type: "device-state", device, state };
}

/** Default production spawn: the GLOBAL `nmcli monitor`, stdout piped. */
function spawnNmcliMonitor(): MonitorProcess {
	return Bun.spawn([NMCLI, ...NMCLI_MONITOR_ARGS], {
		stdout: "pipe",
		stderr: "ignore",
	}) as unknown as MonitorProcess;
}

/**
 * Real, subprocess-backed {@link IMonitorEmitter}. Supervises a long-lived
 * `nmcli monitor` child, parses its stdout, emits {@link MonitorEvent}s, and
 * respawns with backoff on death (calling `onResync` per restart).
 */
export class NmcliMonitorManager implements IMonitorEmitter {
	private readonly listeners = new Set<MonitorEventListener>();
	private running = false;
	private proc: MonitorProcess | null = null;

	constructor(
		private readonly onResync: ResyncCallback,
		private readonly spawn: SpawnMonitor = spawnNmcliMonitor,
	) {}

	on(_event: "monitor-event", listener: MonitorEventListener): void {
		this.listeners.add(listener);
	}

	off(_event: "monitor-event", listener: MonitorEventListener): void {
		this.listeners.delete(listener);
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		void this.supervise();
	}

	stop(): void {
		this.running = false;
		const proc = this.proc;
		this.proc = null;
		if (proc) {
			try {
				proc.kill();
			} catch (err) {
				logger.debug(`nmcli monitor kill failed: ${String(err)}`);
			}
		}
	}

	/** True while the supervisor loop is active. */
	get isRunning(): boolean {
		return this.running;
	}

	private emit(event: MonitorEvent): void {
		// Snapshot to tolerate listeners that unsubscribe during dispatch.
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	/**
	 * Supervisor loop. Each `retryWithBackoff` attempt runs one child to death;
	 * throwing afterwards triggers the next (backed-off) attempt. The first
	 * attempt is the initial spawn; every subsequent attempt is a RESTART and
	 * fires `onResync()` before respawning. `shouldRetry` short-circuits once
	 * `stop()` flips `running` to false.
	 */
	private async supervise(): Promise<void> {
		let attempt = 0;
		try {
			await retryWithBackoff(
				async () => {
					// `retryWithBackoff` re-invokes us after the backoff sleep before
					// re-checking `shouldRetry`; bail cleanly if stopped meanwhile so a
					// `stop()` during backoff never causes one extra spawn.
					if (!this.running) return;
					if (attempt > 0) {
						// Restart: close the no-replay gap by re-polling state.
						this.onResync();
					}
					attempt++;
					await this.runOnce();
					// Stopped while streaming → exit cleanly without a restart.
					if (!this.running) return;
					// Otherwise the child died on its own — force a retry.
					throw new Error("nmcli monitor process exited");
				},
				{
					...RESTART_BACKOFF,
					shouldRetry: () => this.running,
				},
			);
		} catch (err) {
			if (this.running) {
				logger.error(`nmcli monitor supervisor terminated: ${String(err)}`);
			}
		}
	}

	/**
	 * Spawn one child and stream its stdout until it exits. Decodes with a
	 * streaming `TextDecoder` and a newline buffer, carrying the partial tail
	 * across chunk boundaries (chunks do not align to lines — T8 proof).
	 */
	private async runOnce(): Promise<void> {
		const proc = this.spawn();
		this.proc = proc;

		const decoder = new TextDecoder();
		let buffer = "";

		try {
			for await (const chunk of proc.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				let nl = buffer.indexOf("\n");
				while (nl !== -1) {
					this.handleLine(buffer.slice(0, nl));
					buffer = buffer.slice(nl + 1);
					nl = buffer.indexOf("\n");
				}
			}
			// Flush any trailing partial line left without a newline.
			buffer += decoder.decode();
			if (buffer.trim().length > 0) {
				this.handleLine(buffer);
			}
		} finally {
			await proc.exited.catch(() => undefined);
			if (this.proc === proc) this.proc = null;
		}
	}

	/** Parse one line; emit a structured event or log+skip the rest. */
	private handleLine(line: string): void {
		let event: MonitorEvent | null = null;
		try {
			event = parseMonitorLine(line);
		} catch (err) {
			// Defensive: a malformed line must never crash the stream.
			logger.debug(`nmcli monitor parse error for "${line}": ${String(err)}`);
			return;
		}

		if (event) {
			this.emit(event);
			return;
		}

		const trimmed = line.trim();
		if (trimmed.length > 0) {
			logger.debug(`nmcli monitor (skipped): ${trimmed}`);
		}
	}
}

/**
 * Create the monitor emitter appropriate for the current environment.
 *
 * - In dev/test (`shouldUseMockMonitor()` — `MOCK_SCENARIO` set or
 *   `NODE_ENV=test`): returns a scripted {@link MockMonitorEmitter} that NEVER
 *   spawns real nmcli/mmcli.
 * - Otherwise: returns the real {@link NmcliMonitorManager} that spawns the
 *   global `nmcli monitor` and restarts it (calling `onResync`) on death.
 *
 * @param onResync invoked once per real-monitor restart so callers re-poll.
 * @param spawn    optional spawn override (tests inject a fake child).
 */
export function createMonitorManager(
	onResync: ResyncCallback,
	spawn?: SpawnMonitor,
): IMonitorEmitter {
	if (shouldUseMockMonitor()) {
		return new MockMonitorEmitter();
	}
	return new NmcliMonitorManager(onResync, spawn);
}
