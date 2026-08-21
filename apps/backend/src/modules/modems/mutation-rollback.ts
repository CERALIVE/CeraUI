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
 * Capturing a modem's pre-state, and putting it back.
 *
 * The capture is DESCRIPTOR-level and deliberately generic: vid:pid, model,
 * firmware revision, composition mode and ifname, read from the same udev/sysfs
 * enumeration every other identity decision on this device uses. That is what a
 * rollback has to restore and what an acknowledgement has to compare against, and
 * keeping it in one shape means the verification path cannot disagree with the
 * arming path about what "the same state" means.
 *
 * A kind that CAN be put back registers a handler. A kind that cannot has no
 * handler and its rollback answers `unavailable` — which leaves the device
 * fail-closed until an operator acknowledges, rather than pretending a restore
 * happened. That asymmetry is the design: a rollback we cannot perform must be
 * visible, never inferred.
 *
 * `capture` answering `undefined` is the ABSENT-DEVICE signal. It is distinct from
 * a capture that read a device and found a different state, because the two have
 * opposite handling — absence quarantines, difference blocks.
 */

import {
	createUsbEnumerator,
	detectUsbMode,
	type UsbDeviceSnapshot,
} from "@ceralive/modem-control";
import {
	deriveModemStableKey,
	type ModemMutationKind,
} from "@ceraui/rpc/schemas";

export type CapturedState = Readonly<Record<string, unknown>>;

export type RollbackResult = "restored" | "failed" | "unavailable" | "absent";

export interface MutationRollbackHandler {
	rollback(
		stableKey: string,
		preState: CapturedState,
	): Promise<"restored" | "failed">;
}

const handlers = new Map<ModemMutationKind, MutationRollbackHandler>();

export function registerMutationRollback(
	kind: ModemMutationKind,
	handler: MutationRollbackHandler,
): void {
	handlers.set(kind, handler);
}

export function clearMutationRollbacks(): void {
	handlers.clear();
}

export interface MutationCaptureDeps {
	enumerate(): Promise<readonly UsbDeviceSnapshot[]>;
}

export const defaultMutationCaptureDeps: MutationCaptureDeps = {
	enumerate: () => createUsbEnumerator().enumerate(),
};

let activeDeps: MutationCaptureDeps = defaultMutationCaptureDeps;

export function setMutationCaptureDeps(
	deps: Partial<MutationCaptureDeps>,
): void {
	activeDeps = { ...defaultMutationCaptureDeps, ...deps };
}

export function resetMutationCaptureDeps(): void {
	activeDeps = defaultMutationCaptureDeps;
}

function snapshotOf(device: UsbDeviceSnapshot): CapturedState {
	return {
		vidPid: `${device.vendorId.toLowerCase()}:${device.productId.toLowerCase()}`,
		model: device.model ?? "",
		firmwareRevision: device.firmwareRevision ?? "",
		mode: detectUsbMode(device) ?? "unknown",
		ifname: device.ifname ?? "",
	};
}

/** The device's current descriptor state, or `undefined` when it is not present. */
export async function captureModemState(
	stableKey: string,
	deps: MutationCaptureDeps = activeDeps,
): Promise<CapturedState | undefined> {
	const devices = await deps.enumerate();
	const device = devices.find(
		(candidate) => deriveModemStableKey(candidate.physicalUid) === stableKey,
	);
	return device === undefined ? undefined : snapshotOf(device);
}

/**
 * Whether a captured state matches a journaled pre-state.
 *
 * `ifname` is EXCLUDED from the comparison, and that exclusion is load-bearing: a
 * predictable interface name is derived from a MAC that this fleet has already
 * proven can collide, and it legitimately changes across a re-enumeration that
 * restored the correct composition mode. Comparing it would reject a rollback that
 * genuinely succeeded.
 */
export function statesMatch(
	preState: CapturedState,
	current: CapturedState,
): boolean {
	const compared = ["vidPid", "model", "firmwareRevision", "mode"] as const;
	return compared.every((field) => preState[field] === current[field]);
}

/**
 * A captured state is COHERENT when it names a real device rather than a partly
 * enumerated one. It is the validation the force-rebaseline path runs before it
 * will adopt the current hardware as a new baseline.
 */
export function isCoherentState(state: CapturedState): boolean {
	const vidPid = state.vidPid;
	return typeof vidPid === "string" && /^[0-9a-f]{4}:[0-9a-f]{4}$/.test(vidPid);
}

export async function rollbackMutation(
	kind: ModemMutationKind,
	stableKey: string,
	preState: CapturedState,
): Promise<RollbackResult> {
	const current = await captureModemState(stableKey);
	if (current === undefined) return "absent";
	// Already back — nothing to undo. This is the common replay case: an `armed`
	// entry means the mutation had not been dispatched at all.
	if (statesMatch(preState, current)) return "restored";

	const handler = handlers.get(kind);
	if (handler === undefined) return "unavailable";
	try {
		return await handler.rollback(stableKey, preState);
	} catch {
		return "failed";
	}
}
