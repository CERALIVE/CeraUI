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
  Mock monitor event emitter.

  A scripted, in-memory implementation of the shared monitor interface. It
  emits a pre-defined sequence of `MonitorEvent`s on a timer instead of
  spawning / parsing real `nmcli monitor` or `mmcli --monitor-modems`
  subprocesses. Used by tests and by the `MOCK_SCENARIO` dev path.

  The REAL subprocess monitor (T12, `monitor-manager.ts`) implements the same
  `IMonitorEmitter` interface and is the only place allowed to invoke real
  nmcli/mmcli.
*/

import type { IMonitorEmitter, MonitorEvent } from "../state-types.ts";

// `MonitorEvent` and `IMonitorEmitter` are the canonical shared contracts from
// `state-types.ts` (T3). They are re-exported here for the convenience of
// existing consumers/tests that import them from this module.
export type { IMonitorEmitter, MonitorEvent } from "../state-types.ts";

/** Listener invoked for every emitted {@link MonitorEvent}. */
export type MonitorEventListener = (event: MonitorEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Mock implementation
// ─────────────────────────────────────────────────────────────────────────────

/** One scripted step: emit `event` after `delayMs` from `start()`. */
export interface ScriptedMonitorEvent {
	delayMs: number;
	event: MonitorEvent;
}

/**
 * Scripted, subprocess-free {@link IMonitorEmitter}.
 *
 * - Constructed (or `.script()`-ed) with an ordered list of
 *   `{ delayMs, event }` steps.
 * - `start()` schedules each step with `setTimeout(delayMs)` relative to the
 *   call. Steps fire in their scheduled order; equal delays preserve array
 *   order.
 * - `stop()` clears all pending timers without dropping listeners.
 * - `reset()` fully clears timers, listeners and the script.
 *
 * It NEVER spawns or touches real `nmcli` / `mmcli` processes.
 */
export class MockMonitorEmitter implements IMonitorEmitter {
	private readonly listeners = new Set<MonitorEventListener>();
	private timers: Array<ReturnType<typeof setTimeout>> = [];
	private scriptEntries: Array<ScriptedMonitorEvent>;
	private started = false;

	constructor(script: ReadonlyArray<ScriptedMonitorEvent> = []) {
		this.scriptEntries = [...script];
	}

	on(_event: "monitor-event", listener: MonitorEventListener): void {
		this.listeners.add(listener);
	}

	off(_event: "monitor-event", listener: MonitorEventListener): void {
		this.listeners.delete(listener);
	}

	/**
	 * Replace the scripted sequence. Takes effect on the next `start()`; to
	 * re-script a running emitter, call `stop()` (or `reset()`) first.
	 */
	script(entries: ReadonlyArray<ScriptedMonitorEvent>): void {
		this.scriptEntries = [...entries];
	}

	start(): void {
		if (this.started) return;
		this.started = true;

		for (const entry of this.scriptEntries) {
			const timer = setTimeout(
				() => {
					this.dispatch(entry.event);
				},
				Math.max(0, entry.delayMs),
			);
			this.timers.push(timer);
		}
	}

	stop(): void {
		for (const timer of this.timers) {
			clearTimeout(timer);
		}
		this.timers = [];
		this.started = false;
	}

	/** Full teardown: clears pending timers, listeners and the script. */
	reset(): void {
		this.stop();
		this.scriptEntries = [];
		this.listeners.clear();
	}

	/** True while a `start()` has live (or pending) timers. */
	get isStarted(): boolean {
		return this.started;
	}

	private dispatch(event: MonitorEvent): void {
		// Snapshot to tolerate listeners that unsubscribe during dispatch.
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}
}

/**
 * Whether the mock monitor should be used instead of the real subprocess
 * monitor. Active under the existing `MOCK_SCENARIO` dev path and under
 * `NODE_ENV=test`.
 */
export function shouldUseMockMonitor(): boolean {
	return Boolean(process.env.MOCK_SCENARIO) || process.env.NODE_ENV === "test";
}
