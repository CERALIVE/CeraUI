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
 * The ONE typed unavailability vocabulary this module degrades into.
 *
 * There is exactly one token — `bt_unavailable` — plus a CAUSE, because the
 * causes have different operator meanings and must never be collapsed: a dev
 * host that has no Bluetooth at all, a board whose `bluetoothd` is not running,
 * a controller that is not present, and a bus we could not reach are four
 * different sentences. Everything above this module renders the token; the cause
 * is what makes the sentence honest.
 *
 * `emulated` is load-bearing for the dev/CI path: it is reached WITHOUT dialing
 * D-Bus and WITHOUT spawning anything, so a dev host never touches a real
 * `systemctl` or a real system bus.
 */

/** The single degradation token every consumer keys on. */
export const BT_UNAVAILABLE = "bt_unavailable" as const;

export const BT_UNAVAILABLE_CAUSES = [
	/** Dev / emulated host: no Bluetooth hardware, and none is simulated. */
	"emulated",
	/** The BlueZ system bus name has no owner (bluetoothd is not running). */
	"bluez_unavailable",
	/** The system bus itself could not be reached. */
	"bus_unreachable",
	/** BlueZ is up and exposes no `Adapter1` — no controller on this board. */
	"no_adapter",
	/** A required systemd unit is not installed (see `bluealsa.service` pin). */
	"unit_missing",
] as const;

export type BtUnavailableCause = (typeof BT_UNAVAILABLE_CAUSES)[number];

export interface BtUnavailable {
	readonly ok: false;
	readonly error: typeof BT_UNAVAILABLE;
	readonly cause: BtUnavailableCause;
	/** Free-text diagnostic for the log — never rendered to an operator verbatim. */
	readonly detail?: string;
}

export function btUnavailable(
	cause: BtUnavailableCause,
	detail?: string,
): BtUnavailable {
	return detail === undefined
		? { ok: false, error: BT_UNAVAILABLE, cause }
		: { ok: false, error: BT_UNAVAILABLE, cause, detail };
}

/** True for the one shape every consumer must be able to recognise. */
export function isBtUnavailable(value: unknown): value is BtUnavailable {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { error?: unknown }).error === BT_UNAVAILABLE
	);
}
