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
 * THE DEVICE IS ASKED WHAT IT HAS; A MODEL LIST IS NOT CONSULTED FOR THE ANSWER.
 * The offer is gated on the device's OWN enumeration proving a route back to the
 * mode it is in right now, and the reason an offer is withheld comes from the
 * four-state runtime vocabulary (`usb-mode-runtime.ts`) rather than the single
 * word `uncertified`. That word asserted "your model was never reviewed" and was
 * the answer for every real modem on the fleet, including ones whose firmware
 * answers `AT+GTUSBMODE=?` on request — four genuinely different situations
 * collapsed into one sentence an operator could do nothing with.
 *
 * WHAT THE CATALOG STILL DECIDES is the DISPATCHABLE set, and only that. A
 * transition is dispatched through `runUsbModeTransition`, whose engine is
 * catalog-driven and whose confirmation compares the canonical `modem.usb_mode`;
 * a raw vendor target (`40`, `"9011"`) has neither a reviewed command nor a
 * canonical form to confirm against. So the runtime answer gates the offer, the
 * catalog supplies its members, and the two are read through the SAME deps the
 * dispatch runs with — a UI gated on a rule the dispatch does not share is a UI
 * that offers what the device refuses.
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
import {
	foldRuntimeCapability,
	resolveRuntimeCompositionCapability,
	resolveRuntimeVendor,
} from "./usb-mode-runtime.ts";

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
 * THE LADDER IS TRANSPORT-SAFE, AND ITS ORDER IS THE CONTRACT. The three
 * suppressions that need no device contact — an unknown AT dialect, a disabled
 * provisioning switch, a live condition holding the modem — are resolved BEFORE a
 * single byte is written to a tty. Only past all three is the device asked, and
 * `no-return-path` is the one suppression that can only be decided from its
 * reply. Every suppressed state carries ZERO offerable targets.
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

	const query = deps.queryRuntimeComposition;
	if (query === undefined) {
		return catalogOnlyOptions(base, deps, identity);
	}

	const vendor = resolveRuntimeVendor(identity);
	if (vendor === undefined) {
		return { ...base, certified: [], suppressed: "unknown-vendor" };
	}
	if (deps.isProvisioningEnabled?.() === false) {
		return { ...base, certified: [], suppressed: "provisioning-disabled" };
	}
	if (deps.isBlockedByLiveState?.() === true) {
		return { ...base, certified: [], suppressed: "blocked-by-state" };
	}

	const response = await query(identity, vendor);
	if (response === undefined) {
		return { ...base, certified: [], suppressed: "unknown-vendor" };
	}

	const folded = foldRuntimeCapability(
		vendor,
		resolveRuntimeCompositionCapability(response),
	);
	if (!folded.ok) {
		return { ...base, certified: [], suppressed: folded.suppressed };
	}

	return {
		...base,
		certified: [...certifiedUsbTargets(deps.catalog, identity)],
		runtime: folded.evidence,
	};
}

/**
 * The pre-runtime answer, retained verbatim for a build with no AT path wired.
 *
 * `uncertified` survives HERE and nowhere else. It is a true statement on this
 * branch — nothing interrogated the device, so the catalog really is the only
 * evidence there is — and it is the branch no production caller takes.
 */
function catalogOnlyOptions(
	base: { active?: UsbCompositionMode },
	deps: UsbModeDispatchDeps,
	identity: ResolvedModemIdentity,
): UsbModeOptionsOutput {
	if (matchCertifiedEntry(deps.catalog, identity) === undefined) {
		return { ...base, certified: [], suppressed: "uncertified" };
	}
	return {
		...base,
		certified: [...certifiedUsbTargets(deps.catalog, identity)],
	};
}
