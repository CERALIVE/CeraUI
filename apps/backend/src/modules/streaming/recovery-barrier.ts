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
 * The process-level MODEM-MUTATION-REPLAY barrier.
 *
 * It is an AWAITABLE PROMISE rather than a boolean, and that is the whole point.
 * The WS control server binds BEFORE any subsystem initialisation (`main.ts` —
 * it is the operator's only lifeline, so it must come up even when everything
 * else fails), which means a UI RPC, a remote-control command, or a pushed
 * profile can arrive while the journal is still being replayed. A boolean gives
 * exactly one answer to that race — refuse — and refusing is the WRONG answer for
 * the two INTERNAL boot origins:
 *
 *   - stream restoration converts an unhandled refusal into a TERMINAL
 *     `start_failed` and retires its one-shot marker, so a refusal there does not
 *     defer the intent, it destroys it;
 *   - boot autostart records a failed result with no retry at all.
 *
 * So internal origins AWAIT this promise and are admitted afterwards, while
 * external arrivals get the typed `recovery_pending` refusal, which is honest
 * ("ask again in a moment") and costs the caller nothing but a retry.
 *
 * The default state is COMPLETE. A device that never begins a replay — every unit
 * test, every dev host, and any boot where the journal subsystem failed to start
 * — must not be silently held forever by a barrier nobody will ever lower.
 */

import { logger } from "../../helpers/logger.ts";

let pending = false;
let settled: Promise<void> = Promise.resolve();
let lower: (() => void) | undefined;

export function beginRecoveryBarrier(): void {
	if (pending) return;
	pending = true;
	settled = new Promise<void>((resolve) => {
		lower = resolve;
	});
}

export function completeRecoveryBarrier(): void {
	if (!pending) return;
	pending = false;
	const resolve = lower;
	lower = undefined;
	resolve?.();
	logger.info("modem-mutation replay complete; admission barrier lowered", {
		module: "modems",
	});
}

export function isRecoveryPending(): boolean {
	return pending;
}

/** Resolves once replay has finished. Resolves immediately when none is running. */
export function awaitRecoveryBarrier(): Promise<void> {
	return settled;
}

/** Test-only: drop any raised barrier so a suite starts from a lowered state. */
export function resetRecoveryBarrier(): void {
	pending = false;
	lower?.();
	lower = undefined;
	settled = Promise.resolve();
}
