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
 * The engine-execution half of a USB-composition switch: everything AFTER the
 * gates and the catalog, run INSIDE the armed journal entry.
 *
 * The two-stage confirmation is the reason this is not folded into the dispatch.
 * The engine's own postcondition proves the composition mode changed; only a
 * re-registered device carrying a data path proves the LINK came back, and the
 * armed rollback is cancelled only once both hold. A modem that switched
 * perfectly and never re-registered is exactly the state whose pre-state an
 * operator needs kept.
 */

import {
	type CatalogEntry,
	epochMillis,
	type MmUsbMode,
	connectionId as toConnectionId,
	deviceIfname as toDeviceIfname,
	type UsbModeTransitionOutcome,
} from "@ceralive/modem-control";
import type { UsbCompositionMode } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

import type { JournaledMutation } from "./mutation-lease.ts";
import {
	refuse,
	type UsbModeDispatchDeps,
	type UsbModeDispatchResult,
	type UsbModeTransitionEngine,
} from "./usb-mode-contract.ts";
import { type ResolvedModemIdentity, skuOf } from "./usb-mode-identity.ts";

export type TransitionRun = {
	readonly deps: UsbModeDispatchDeps;
	readonly deviceId: string;
	readonly engine: UsbModeTransitionEngine;
	readonly entry: CatalogEntry;
	readonly from: MmUsbMode & UsbCompositionMode;
	readonly identity: ResolvedModemIdentity;
	readonly inhibitUid: string;
	readonly mutation: JournaledMutation;
	readonly nmConnection: string;
	readonly target: MmUsbMode & UsbCompositionMode;
};

export async function executeTransition(run: TransitionRun): Promise<{
	readonly confirmed: boolean;
	readonly value: UsbModeDispatchResult;
	readonly detail?: string;
}> {
	const { deps, deviceId, engine, entry, from, identity, target } = run;
	await run.mutation.markExecuting();

	let outcome: UsbModeTransitionOutcome;
	try {
		outcome = await engine.execute({
			stableKey: identity.stableKey,
			sku: skuOf(entry),
			fromMode: from,
			toMode: target,
			connectionId: toConnectionId(run.nmConnection),
			deviceIfname: toDeviceIfname(identity.ifname),
			cachedPhysicalUid: identity.physicalUid,
			inhibitUid: run.inhibitUid,
			// Both flags are the engine's own TOCTOU boundary. The RPC's
			// `confirm: z.literal(true)` already proved operator intent, and the
			// provisioning key is this device's maintenance switch.
			confirm: true,
			maintenance: true,
			now: epochMillis(deps.now()),
			// Re-polled by the engine at entry AND in-actor. We only ever reach here
			// with a device udev positively identified moments ago.
			probeReadiness: () => Promise.resolve({ identityConfidence: "high" }),
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		logger.warn(`modems.setUsbMode(${deviceId} → ${target}) threw: ${detail}`, {
			module: "modems",
		});
		return {
			confirmed: false,
			detail,
			value: refuse("transition_failed", "transaction_error"),
		};
	}

	if (outcome.status === "refused") {
		logger.warn(
			`modems.setUsbMode(${deviceId} → ${target}) refused at ${outcome.stage}: ${outcome.reason}`,
			{ module: "modems" },
		);
		// A refusal means the transaction never began, so the pre-state is still
		// current and the armed entry is cancelled rather than left blocking.
		return {
			confirmed: true,
			value: refuse("transition_failed", "preconditions_refused"),
		};
	}

	if (outcome.status === "failed") {
		logger.warn(
			`modems.setUsbMode(${deviceId} → ${target}) failed: ${outcome.reason}`,
			{ module: "modems", degraded: outcome.degraded },
		);
		// The transaction distinguishes "the device came back as something else"
		// from "the transaction blew up"; the operator's next action differs.
		return {
			confirmed: false,
			detail: outcome.reason,
			value: refuse(
				"transition_failed",
				outcome.steps.includes("postcondition")
					? "postcondition_mismatch"
					: "transaction_error",
			),
		};
	}

	// The engine verified descriptors AND observed mode against the catalog
	// target; that proves the composition changed, not that the link came back.
	// The armed rollback is cancelled only once the data path is confirmed too.
	const restored = await deps.confirmDataPath(outcome.newIfname);
	if (!restored) {
		logger.warn(
			`modems.setUsbMode(${deviceId} → ${target}) switched but did not restore its data path`,
			{ module: "modems", stableKey: identity.stableKey },
		);
		return {
			confirmed: false,
			detail: "no data path after the switch",
			value: refuse("transition_failed", "postcondition_mismatch"),
		};
	}

	// Trigger ONE immediate re-discovery + `modems` broadcast (the
	// `sim-autounlock` precedent): the regular loop only publishes every 30 s, so
	// without this the confirming snapshot lands long after any reasonable UI
	// bound and a genuinely-successful switch reads as a timeout.
	logger.info(
		`modems.setUsbMode(${deviceId} → ${target}) succeeded; new ifname ${outcome.newIfname}`,
		{ module: "modems", stableKey: identity.stableKey },
	);
	await deps.rediscover();
	return { confirmed: true, value: { success: true } };
}
