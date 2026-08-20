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
 * Putting a modem's band selection back, from a journal entry alone.
 *
 * This is the half of the timed rollback that survives a backend restart. The
 * in-process path in `band-lock.ts` restores while it still holds the device;
 * a process that died inside the registration window left an `executing` entry,
 * and startup replay reaches THIS handler with nothing but the stable key and
 * the persisted pre-state. So it must re-find the device from the key alone —
 * it cannot be handed a modem id, because the id is a ModemManager index that a
 * re-enumeration re-issues.
 *
 * It takes NO lease and writes NO journal entry, for the same reason
 * `usb-mode-rollback.ts` does not: both callers already own those. Startup
 * replay holds no lease (the process that did is gone) and is itself writing the
 * entry; the acknowledgement path is reading one. A second lease here would
 * deadlock against the first.
 *
 * An EMPTY persisted selection restores `any`, and that is deliberate rather
 * than a fallback: a modem whose pre-state could not be read was, as far as
 * anything can tell, not deliberately locked, and `any` is the only selection
 * guaranteed to be reachable from wherever the failed change left it.
 */

import { BAND_ANY, deriveModemStableKey } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

import { readModemBands, writeModemBands } from "./band-mmcli.ts";
import { getModemIdPath } from "./modem-wire-producer.ts";
import { getModems } from "./modems-state.ts";
import { registerMutationRollback } from "./mutation-rollback.ts";

/** The mmcli id of the modem behind a stable key, or `undefined`. */
export function modemIdForStableKey(stableKey: string): string | undefined {
	for (const [id, modem] of Object.entries(getModems())) {
		const idPath = getModemIdPath(modem.ifname);
		if (idPath !== undefined && deriveModemStableKey(idPath) === stableKey) {
			return id;
		}
	}
	return undefined;
}

function bandsFrom(
	preState: Readonly<Record<string, unknown>>,
): readonly string[] {
	const bands = preState.bands;
	if (!Array.isArray(bands)) return [BAND_ANY];
	const named = bands.filter(
		(band): band is string => typeof band === "string",
	);
	return named.length > 0 ? named : [BAND_ANY];
}

export async function restoreBandLock(
	stableKey: string,
	preState: Readonly<Record<string, unknown>>,
): Promise<"restored" | "failed"> {
	const deviceId = modemIdForStableKey(stableKey);
	if (deviceId === undefined) return "failed";

	const target = bandsFrom(preState);
	const before = await readModemBands(deviceId);
	// Already back. The common replay case: an `armed` entry means the write was
	// never dispatched at all, so there is nothing to undo.
	if (before.ok && sameSet(before.current, target)) return "restored";

	if (!(await writeModemBands(deviceId, target))) {
		logger.warn("band rollback: the modem refused the restore", {
			module: "modems",
			stableKey,
			target,
		});
		return "failed";
	}

	// A restore is only restored once the modem SAYS so. Reporting on the write's
	// own confirmation would clear a journal entry for a device that silently
	// ignored it — the exact failure the readback step exists to catch forward.
	const after = await readModemBands(deviceId);
	return after.ok && sameSet(after.current, target) ? "restored" : "failed";
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const wanted = new Set(a);
	return b.every((band) => wanted.has(band));
}

registerMutationRollback("band-lock", { rollback: restoreBandLock });
