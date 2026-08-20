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
 * Whether this device can honour "Automatic APN" at all.
 *
 * The answer used to be the STATIC `setup.has_gsm_autoconfig` key — and no
 * shipped `setup.json` carries it, so on every board in the field it read
 * `undefined`, i.e. falsy. That made the Automatic-APN switch a dead control in
 * both directions: `sanitizeModemConfigForNetworkManager` forced
 * `gsm.auto-config: no` AND reset `config.autoconfig` to `false`, so the
 * operator's choice was discarded on the way to NetworkManager and again on the
 * way back to the wire. Board-measured on a Rock 5B+ (2026-08-16): the switch
 * was turned on, the dialog reported success and closed, `nmcli` still read
 * `gsm.auto-config: no`, and reopening the dialog showed the switch off again.
 *
 * This is the same drift class as `setup.sound_device_dir` (see
 * `alsa-card-scan.ts`): a static value packaged into a separately-versioned
 * `.deb`, describing a capability the running system can simply be ASKED about.
 *
 * Resolution, highest authority first:
 *
 *  1. an EXPLICIT `setup.has_gsm_autoconfig` boolean — an image that states the
 *     answer is trusted in BOTH directions, including an explicit `false` opt-out;
 *  2. the PROBE — did NetworkManager answer when we read `gsm.auto-config` off a
 *     real gsm profile (`recordGsmAutoconfigProbe`, called from
 *     `gsm-connections.ts` while it is already enumerating them);
 *  3. `false` — nothing has answered yet, so the capability is not claimed.
 *
 * Step 3 is FAIL-CLOSED on purpose: an unprobed device must not be told its
 * Automatic-APN switch works. It is not a permanent verdict — the first
 * `readGsmConnections()` pass resolves it, and registration creates a profile
 * before any operator can reach the dialog.
 */

import { logger } from "../../helpers/logger.ts";
import { setup } from "../setup.ts";

/** `undefined` = nothing has probed yet. */
let probedSupport: boolean | undefined;

/**
 * Record what NetworkManager answered when asked for `gsm.auto-config`.
 *
 * Only a POSITIVE answer is sticky. A failed read is recorded too, but a later
 * successful one overrides it — an nmcli call can fail for reasons that say
 * nothing about the property (a profile that vanished mid-read), and refusing
 * to ever revise the answer would strand the capability off for the process
 * lifetime over one transient.
 */
export function recordGsmAutoconfigProbe(supported: boolean): void {
	if (probedSupport === supported) return;
	if (probedSupport === true && !supported) {
		// Keep the positive answer; log so a real regression is still visible.
		logger.debug(
			"gsm.auto-config probe failed after a successful one; keeping supported=true",
		);
		return;
	}
	probedSupport = supported;
	logger.info(
		`NetworkManager gsm.auto-config support probed as ${supported ? "AVAILABLE" : "unavailable"}`,
	);
}

/** The probe's own answer, or `undefined` when nothing has probed yet. */
export function getProbedGsmAutoconfigSupport(): boolean | undefined {
	return probedSupport;
}

/** Test seam — drops the probed answer so a suite starts from "unprobed". */
export function resetGsmAutoconfigProbe(): void {
	probedSupport = undefined;
}

/**
 * Whether "Automatic APN" may be offered and written on this device.
 *
 * Read this instead of `setup.has_gsm_autoconfig` — every consumer must agree,
 * or the wire echo and the NetworkManager write disagree about the same switch.
 */
export function resolveGsmAutoconfigSupport(): boolean {
	if (typeof setup.has_gsm_autoconfig === "boolean") {
		return setup.has_gsm_autoconfig;
	}
	return probedSupport === true;
}
