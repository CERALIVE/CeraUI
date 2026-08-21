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
 * The GNSS display state machine — bounded acquisition and stale-fix expiry.
 *
 * It exists to make two dishonest renders impossible rather than merely
 * unlikely:
 *
 *   1. An endless "acquiring…" spinner. A modem with no antenna answers "no fix"
 *      forever, quite correctly, and a naive caller waits forever. Acquisition
 *      here is BOUNDED — past `GNSS_ACQUIRE_TIMEOUT_MS` the state becomes
 *      `no-fix`, which is a terminal render.
 *   2. A stale coordinate shown as current. The wire type carries a fix ONLY in
 *      the `fix` arm, and every exit from that arm DROPS it rather than carrying
 *      it forward, so there is no path that can render a position the modem is
 *      no longer reporting.
 *
 * Pure and total: no clock, no I/O. The caller supplies `at` on every event,
 * which is what makes both bounds testable without waiting for real time.
 *
 * It is a Rule-D MIRROR of `modem-stack`'s `control/src/location/fix-state.ts`,
 * never a shared import — the same relationship `usb-net-classifier.ts` has with
 * `device-classifier.ts`. The two halves are kept honest by their tests.
 */

import type { GnssFix, GnssFixState } from "@ceraui/rpc/schemas";
import { GNSS_ACQUIRE_TIMEOUT_MS, GNSS_FIX_TTL_MS } from "@ceraui/rpc/schemas";

export type GnssFixStateConfig = {
	readonly acquireTimeoutMs: number;
	readonly fixTtlMs: number;
};

export const DEFAULT_GNSS_FIX_CONFIG: GnssFixStateConfig = {
	acquireTimeoutMs: GNSS_ACQUIRE_TIMEOUT_MS,
	fixTtlMs: GNSS_FIX_TTL_MS,
};

/** What one read of the device produced. Mirrors the modem-stack `FixRead`. */
export type GnssRead =
	| { readonly outcome: "fix"; readonly fix: GnssFix }
	| { readonly outcome: "no-fix" }
	| { readonly outcome: "disabled" }
	| { readonly outcome: "unavailable"; readonly reason: string };

export type GnssFixEvent =
	| { readonly kind: "gnss-enabled"; readonly at: number }
	| { readonly kind: "gnss-disabled" }
	| { readonly kind: "read"; readonly at: number; readonly read: GnssRead }
	| { readonly kind: "tick"; readonly at: number };

export const GNSS_OFF: GnssFixState = { kind: "off" };

/** A fix is reachable ONLY here, and only while the state actually holds one. */
export function renderableFix(state: GnssFixState): GnssFix | undefined {
	return state.kind === "fix" ? state.fix : undefined;
}

function acquiring(since: number, config: GnssFixStateConfig): GnssFixState {
	return {
		kind: "acquiring",
		since,
		deadline: since + config.acquireTimeoutMs,
	};
}

function expireIfDue(
	state: GnssFixState,
	at: number,
	config: GnssFixStateConfig,
): GnssFixState {
	if (state.kind === "acquiring" && at >= state.deadline) {
		return { kind: "no-fix", since: at, reason: "acquire-timeout" };
	}
	if (state.kind === "fix" && at - state.fix.observedAt >= config.fixTtlMs) {
		return { kind: "no-fix", since: at, reason: "fix-expired" };
	}
	return state;
}

function applyRead(
	state: GnssFixState,
	at: number,
	read: GnssRead,
	config: GnssFixStateConfig,
): GnssFixState {
	switch (read.outcome) {
		case "fix":
			return { kind: "fix", fix: read.fix };
		case "no-fix":
			// Still inside the bound, the receiver simply has not acquired yet —
			// that is what `acquiring` means, so a report of no-fix does not end the
			// wait. Any other state (including a held fix) drops to an honest
			// `no-fix`, because a fix the modem no longer reports is not current.
			return state.kind === "acquiring"
				? expireIfDue(state, at, config)
				: { kind: "no-fix", since: at, reason: "reported-no-fix" };
		case "disabled":
			return GNSS_OFF;
		case "unavailable":
			return { kind: "unavailable", reason: read.reason };
	}
}

/** Pure, total transition. Every exit from `fix` drops the coordinates. */
export function advanceGnssFixState(
	state: GnssFixState,
	event: GnssFixEvent,
	config: GnssFixStateConfig = DEFAULT_GNSS_FIX_CONFIG,
): GnssFixState {
	switch (event.kind) {
		case "gnss-enabled":
			return state.kind === "fix" ? state : acquiring(event.at, config);
		case "gnss-disabled":
			return GNSS_OFF;
		case "read":
			return applyRead(state, event.at, event.read, config);
		case "tick":
			return expireIfDue(state, event.at, config);
	}
}
