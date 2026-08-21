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
 * Resolving the mutation lease's KEY from whatever identifier an entrypoint was
 * handed — an mmcli index, a ModemManager object path, or an interface name.
 *
 * Every one of those is a per-boot handle: the index is a ModemManager slot that
 * a re-enumeration re-issues, and the ifname is derived from a MAC this fleet has
 * already proven can collide. They are used here ONLY as the one-instant lookup
 * that finds the physical device; the value returned is the `ID_PATH`-derived
 * `stable_key`, which is the only identifier that survives a mutation.
 *
 * `undefined` is a FIRST-CLASS answer and the caller's cue to refuse with
 * `identity_unresolved`. The identity contract permits an omitted `stable_key`,
 * so a device with no `ID_PATH` genuinely cannot be journaled or followed, and
 * guessing a key would file one device's rollback under another's slot.
 */

import { deriveModemStableKey } from "@ceraui/rpc/schemas";

import { mockModems } from "../../mocks/mock-config.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";

import { getModemIdPath } from "./modem-wire-producer.ts";
import { getModem } from "./modems-state.ts";

const MM_INDEX_RE = /(?:^|\/)(\d+)$/;

export function modemStableKeyForIfname(ifname: string): string | undefined {
	if (ifname === "") return undefined;
	const idPath = getModemIdPath(ifname);
	return idPath === undefined ? undefined : deriveModemStableKey(idPath);
}

export function modemStableKeyForId(id: number): string | undefined {
	const ifname = getModem(id)?.ifname ?? mockIfnameForId(id);
	return ifname === undefined ? undefined : modemStableKeyForIfname(ifname);
}

/**
 * Under `MOCK_SCENARIO` the roster lives in the scenario rather than in the live
 * mmcli state, so the ifname is read from there. It resolves through the SAME
 * `ID_PATH` map and the SAME derivation as a real device — a mock host must
 * exercise the identity rule, not bypass it.
 */
function mockIfnameForId(id: number): string | undefined {
	if (!shouldUseMocks()) return undefined;
	return mockModems.find((modem) => modem.id === id)?.interfaceName;
}

/**
 * Accepts either an mmcli index (`"4"`) or a ModemManager object path
 * (`"/org/freedesktop/ModemManager1/Modem/4"`) — the SIM procedures are handed
 * one or the other and both name the same slot.
 */
export function modemStableKeyForMmTarget(target: string): string | undefined {
	const index = MM_INDEX_RE.exec(target.trim())?.[1];
	if (index === undefined) return undefined;
	return modemStableKeyForId(Number(index));
}

/** The shape every capability module's `resolveIdentity` seam consumes. */
export type ModemIdentityAnchor = { readonly stableKey: string };

/**
 * The capability modules' identity resolver.
 *
 * They correlate on the `stable_key` and on NOTHING else — a USSD dialogue, a
 * GNSS session and the lease that guards them are all filed under it — so this
 * answers with exactly that, through the SAME udev-net-record source
 * `modemStableKeyForId` already reads. It is deliberately NOT
 * `defaultResolveIdentity`: that one additionally enumerates USB to recover the
 * catalog discriminators a composition switch needs, which a PCIe-attached or
 * momentarily-unenumerable modem cannot supply — and a module that never looks
 * at those fields must not be refused for their absence.
 */
export function resolveModemIdentityAnchor(
	deviceId: string,
): Promise<ModemIdentityAnchor | undefined> {
	const stableKey = modemStableKeyForMmTarget(deviceId);
	return Promise.resolve(stableKey === undefined ? undefined : { stableKey });
}
