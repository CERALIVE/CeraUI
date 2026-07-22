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
 * Pure notification-liveness arithmetic (device-quality-wave2 Todo 23b).
 *
 * Extracted from `notifications.ts` so the expiry semantics are unit-testable
 * without a clock, a socket, or the module's persistent-map state.
 *
 * Semantics (the fix):
 *   - A PERSISTENT notification never expires on a timer. It is shown to every
 *     new client and cleared only by an explicit remove/dismiss, so `duration`
 *     does NOT apply to it. This was the bug: the old code expired persistent
 *     notifications once their duration elapsed.
 *   - `duration` governs ONLY non-persistent notifications: `0` means "never
 *     expires", any positive value is a countdown in whole seconds.
 *
 * Return contract (matches the historical `_notificationIsLive` return):
 *   - `false`  => expired; the caller must drop it.
 *   - `0`      => lives forever (no countdown — the `NOTIFICATION_LIVES_FOREVER`
 *                 sentinel). Callers test `!== false`, so `0` reads as "live".
 *   - `n > 0`  => still live; `n` whole seconds remain.
 */

/** Sentinel: the notification never times out (no countdown). */
export const NOTIFICATION_LIVES_FOREVER = 0;

export interface NotificationLivenessInput {
	/** Persistent notifications never expire on a timer. */
	isPersistent: boolean;
	/** Countdown length in seconds; `0` = never expires. Non-persistent only. */
	duration: number;
	/** Timestamp (ms) the notification was last updated/created. */
	updatedMs: number;
	/** Current time (ms). Injected so the arithmetic is clock-free and testable. */
	nowMs: number;
}

/**
 * Compute a notification's remaining liveness.
 *
 * @returns `false` when expired, `0` when it lives forever, or the positive
 *   whole-second remainder while a timed (non-persistent) notification is live.
 */
export function notificationRemaining(
	input: NotificationLivenessInput,
): number | false {
	// Persistent: never expires — `duration` does not apply.
	if (input.isPersistent) return NOTIFICATION_LIVES_FOREVER;

	// Non-persistent with no duration: also never expires.
	if (input.duration === 0) return NOTIFICATION_LIVES_FOREVER;

	// Non-persistent countdown. A backwards clock skew (nowMs < updatedMs)
	// yields negative elapsed → remaining > duration → still live: a skew never
	// prematurely expires a notification.
	const elapsedSeconds = (input.nowMs - input.updatedMs) / 1000;
	const remaining = Math.ceil(input.duration - elapsedSeconds);
	return remaining <= 0 ? false : remaining;
}
