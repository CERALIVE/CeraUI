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

/**
 * Boot readiness surface (S6 boot fail-soft).
 *
 * Tracks whether any NON-CRITICAL boot init degraded (failed) during startup.
 * The device can be fully "up" — the WS control server bound, the operator
 * reachable — while still being "readiness-reduced": one or more optional
 * subsystems failed to initialise. Operators (and a systemd watchdog) need to
 * see that distinction rather than guess from a half-working UI.
 *
 * This is process-wide module state (same posture as the identity /
 * control-channel singletons). It is surfaced read-only on the local
 * `/api/health` endpoint via {@link module:observability} — LOCAL-ONLY, no
 * remote egress.
 */

export interface BootReadiness {
	/** True when at least one non-critical boot init failed. */
	degraded: boolean;
	/** Names of the subsystems whose init failed, in first-failure order. */
	degradedSubsystems: string[];
}

// First-failure-ordered, de-duplicated list of degraded subsystems.
const degradedSubsystems: string[] = [];

/**
 * Record that a non-critical subsystem failed to initialise. Idempotent — a
 * subsystem that re-fails (e.g. a retried init) is not listed twice.
 */
export function markBootDegraded(subsystem: string): void {
	if (!degradedSubsystems.includes(subsystem)) {
		degradedSubsystems.push(subsystem);
	}
}

/** Snapshot of the current boot-readiness state (defensive copy). */
export function getBootReadiness(): BootReadiness {
	return {
		degraded: degradedSubsystems.length > 0,
		degradedSubsystems: [...degradedSubsystems],
	};
}

/** Whether boot left the device in a readiness-reduced state. */
export function isBootDegraded(): boolean {
	return degradedSubsystems.length > 0;
}

/** Test-only: clear the recorded degradation so each case starts clean. */
export function resetBootReadiness(): void {
	degradedSubsystems.length = 0;
}
