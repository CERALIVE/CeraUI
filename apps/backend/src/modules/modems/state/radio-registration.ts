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

import type { Modem } from "../modems-state.ts";

/** The registration state from one successful owner read, and when it was read. */
export type RadioRegistrationObservation = Readonly<{
	value: string | undefined;
	capturedAt: number;
}>;

const observations = new WeakMap<Modem, RadioRegistrationObservation>();

/** Attach the owner read to the modem object it was merged into. */
export function recordRadioRegistration(
	modem: Modem,
	observation: RadioRegistrationObservation,
): void {
	observations.set(modem, observation);
}

/** A timestamp belongs to the successful owner read, never to a cache lookup. */
export function getRadioRegistrationObservation(
	modem: Modem | undefined,
): RadioRegistrationObservation | undefined {
	return modem ? observations.get(modem) : undefined;
}

/**
 * Keep the last owner read when a modem object is replaced without a new one
 * (a late SIM read, a cleared lock), as long as it is the same interface and
 * the SIM is the same or was not read before. The read time is unchanged.
 */
export function carryRadioRegistration(
	from: Modem | undefined,
	to: Modem,
): void {
	if (!from || from === to || observations.has(to)) return;
	const observation = observations.get(from);
	if (
		observation &&
		from.ifname === to.ifname &&
		(from.iccid === undefined || from.iccid === to.iccid)
	)
		observations.set(to, observation);
}
