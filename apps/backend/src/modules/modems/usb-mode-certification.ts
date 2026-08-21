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
 * WHICH composition modes may be offered for one modem — the pure-read half of
 * the USB-mode contract, asked before a control is rendered.
 *
 * It answers with the SAME lookup {@link runUsbModeTransition} gates on: the
 * device is resolved by `resolveIdentity`, matched against the catalog by
 * `matchCertifiedEntry`, and the answer is that entry's own
 * `permittedTransitions`. There is deliberately no second certification rule
 * here — a UI gated on a rule the dispatch does not share is a UI that offers
 * what the device refuses, which is the defect this closes.
 */

import type {
	UsbCompositionMode,
	UsbModeOptionsOutput,
} from "@ceraui/rpc/schemas";

import type { UsbModeDispatchDeps } from "./usb-mode-contract.ts";
import {
	isMmTransitionMode,
	matchCertifiedEntry,
	type ResolvedModemIdentity,
} from "./usb-mode-identity.ts";

/**
 * The certified TARGET modes reachable from the device's CURRENT mode.
 *
 * `from` is matched on the live mode rather than on the entry's `canonicalMode`,
 * because a device that has already been switched is not in the mode its catalog
 * entry was written around, and offering it that entry's whole transition table
 * would offer transitions out of a mode it is not in.
 *
 * Ordering follows the catalog's own declaration order — the reviewed order in
 * the evidence bundle — so a rendered list cannot depend on Set iteration.
 */
export function certifiedUsbTargets(
	catalog: UsbModeDispatchDeps["catalog"],
	identity: Pick<
		ResolvedModemIdentity,
		"vidPid" | "model" | "firmwareRevision" | "currentMode"
	>,
): readonly UsbCompositionMode[] {
	const from = identity.currentMode;
	if (from === undefined || !isMmTransitionMode(from)) return [];

	const entry = matchCertifiedEntry(catalog, identity);
	if (entry === undefined) return [];

	const targets: UsbCompositionMode[] = [];
	for (const transition of entry.permittedTransitions) {
		if (transition.from !== from) continue;
		if (!targets.includes(transition.to)) targets.push(transition.to);
	}
	return targets;
}

/**
 * The wire answer for one modem id.
 *
 * A device that cannot be resolved reports `identity_unresolved` and NO modes.
 * That is the honest answer for the three cases it covers — a native-PCIe modem,
 * a router-mode dongle, and a device that has gone away all fail to resolve,
 * and none of them has a USB composition a switch could act on.
 *
 * A device that resolves but matches no catalog entry reports `uncertified`.
 * A device that matches an entry with no way OUT of its current mode reports an
 * empty set and NO reason: its model was reviewed, so naming it uncertified
 * would be false.
 */
export async function resolveUsbModeOptions(
	deviceId: string,
	deps: UsbModeDispatchDeps,
): Promise<UsbModeOptionsOutput> {
	const identity = await deps.resolveIdentity(deviceId);
	if (identity === undefined) {
		return { certified: [], suppressed: "identity_unresolved" };
	}

	const active = identity.currentMode;
	const base = active !== undefined ? { active } : {};

	if (matchCertifiedEntry(deps.catalog, identity) === undefined) {
		return { ...base, certified: [], suppressed: "uncertified" };
	}

	return {
		...base,
		certified: [...certifiedUsbTargets(deps.catalog, identity)],
	};
}
