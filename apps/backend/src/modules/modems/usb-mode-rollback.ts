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
 * Putting a modem's USB composition mode back.
 *
 * A rollback is the SAME certified transaction in the other direction, and it has
 * to be: the catalog permits transitions pairwise, so restoring a mode is only
 * legal if the catalog says the reverse edge exists. That is a feature — a device
 * whose SKU was certified in one direction only cannot be silently driven back
 * through an unreviewed path, and the honest answer there is a rollback that
 * `failed`, which leaves the operator with the two acknowledgement paths.
 *
 * It runs WITHOUT taking the mutation lease or writing a journal entry, because
 * both callers already own those: startup replay holds no lease (the process that
 * did is gone) and is itself writing the entry, and the acknowledgement path is
 * reading one. Taking a second lease here would deadlock against the first.
 */

import {
	CERTIFIED_CATALOG,
	epochMillis,
	findPermittedTransition,
	connectionId as toConnectionId,
	deviceIfname as toDeviceIfname,
} from "@ceralive/modem-control";

import {
	type UsbCompositionMode,
	usbCompositionModeSchema,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { getModemIds } from "./modems-state.ts";
import { registerMutationRollback } from "./mutation-rollback.ts";
import { createTransitionEngine } from "./transition-engine.ts";
import {
	defaultResolveConnectionId,
	defaultResolveIdentity,
	isMmTransitionMode,
	matchCertifiedEntry,
	type ResolvedModemIdentity,
	skuOf,
} from "./usb-mode-identity.ts";

function isUsbCompositionMode(value: unknown): value is UsbCompositionMode {
	return usbCompositionModeSchema.safeParse(value).success;
}

async function findByStableKey(
	stableKey: string,
): Promise<ResolvedModemIdentity | undefined> {
	for (const id of getModemIds()) {
		const identity = await defaultResolveIdentity(String(id));
		if (identity?.stableKey === stableKey) return identity;
	}
	return undefined;
}

export async function restoreUsbMode(
	stableKey: string,
	preState: Readonly<Record<string, unknown>>,
): Promise<"restored" | "failed"> {
	const target = preState.mode;
	if (!isUsbCompositionMode(target) || !isMmTransitionMode(target)) {
		return "failed";
	}

	const identity = await findByStableKey(stableKey);
	if (identity === undefined) return "failed";
	const from = identity.currentMode;
	if (from === undefined || !isMmTransitionMode(from)) return "failed";
	if (from === target) return "restored";

	const entry = matchCertifiedEntry(CERTIFIED_CATALOG, identity);
	if (entry === undefined) return "failed";
	if (findPermittedTransition(entry, from, target) === undefined) {
		logger.warn(
			"no certified reverse transition; USB mode cannot be restored",
			{
				module: "modems",
				stableKey,
				from,
				target,
			},
		);
		return "failed";
	}

	const engine = createTransitionEngine({ stableKey, ports: identity.ports });
	if (engine === undefined) return "failed";
	const nmConnection = await defaultResolveConnectionId(identity.ifname);
	if (nmConnection === undefined) return "failed";

	const outcome = await engine.execute({
		stableKey,
		sku: skuOf(entry),
		fromMode: from,
		toMode: target,
		connectionId: toConnectionId(nmConnection),
		deviceIfname: toDeviceIfname(identity.ifname),
		cachedPhysicalUid: identity.physicalUid,
		inhibitUid: identity.physicalUid,
		confirm: true,
		maintenance: true,
		now: epochMillis(Date.now()),
		probeReadiness: () => Promise.resolve({ identityConfidence: "high" }),
	});
	return outcome.status === "succeeded" ? "restored" : "failed";
}

registerMutationRollback("usb-mode", { rollback: restoreUsbMode });
