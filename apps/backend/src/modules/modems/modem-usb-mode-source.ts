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
 * WHICH USB composition each attached modem is CURRENTLY enumerated as, keyed by
 * the same stable key every other modem adapter correlates on.
 *
 * This is the third module in the family `modem-id-path-source.ts` opened, and it
 * closes the same shape of defect. `usb_mode` reaches the wire through
 * `DbusModemView.usbMode`, and NOTHING outside `mocks/providers/cellular.ts` ever
 * set it: the D-Bus fold reads ModemManager's own properties, and ModemManager
 * does not report a USB composition. So on every real board the field was absent,
 * and the frontend's USB-mode card — which renders only when an active or
 * recommended mode is known — could not appear on hardware at all, no matter what
 * the certified catalog said. The composition lives in the USB DESCRIPTORS, which
 * is what this module reads.
 *
 * It re-uses `createUsbEnumerator` + `detectUsbMode`, the SAME pair
 * `usb-mode-identity.ts` resolves a transition's `currentMode` with, so the mode
 * a row advertises and the mode a transition gates `from` cannot disagree.
 */

import {
	type CanonicalUsbMode,
	createUsbEnumerator,
	detectUsbMode,
} from "@ceralive/modem-control";
import { deriveModemStableKey } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

let usbModes: ReadonlyMap<string, CanonicalUsbMode> = new Map();

/** Test seam, mirroring the `set*Runner` convention used across this family. */
let readUsbModes: () => Promise<ReadonlyMap<string, CanonicalUsbMode>> =
	readUsbModesFromUdev;

export function setModemUsbModeReaderForTest(
	reader: (() => Promise<ReadonlyMap<string, CanonicalUsbMode>>) | null,
): void {
	readUsbModes = reader ?? readUsbModesFromUdev;
}

async function readUsbModesFromUdev(): Promise<
	ReadonlyMap<string, CanonicalUsbMode>
> {
	const modes = new Map<string, CanonicalUsbMode>();
	for (const device of await createUsbEnumerator().enumerate()) {
		const key = deriveModemStableKey(device.physicalUid);
		const mode = detectUsbMode(device);
		if (key === undefined || mode === undefined) continue;
		modes.set(key, mode);
	}
	return modes;
}

/**
 * Re-read the `stableKey → composition` map.
 *
 * Refreshed on the same PRESENCE edges as the `ID_PATH` map, for the same reason
 * and with the same failure rule: an unreadable udev database is a statement
 * about the READ, so the previous map is RETAINED rather than cleared. Clearing
 * it would withdraw the USB-mode card from every row on one transient failure.
 *
 * A composition change is itself a presence edge — the device physically
 * re-enumerates — so the poll cannot miss one.
 */
export async function refreshModemUsbModes(): Promise<void> {
	try {
		usbModes = await readUsbModes();
	} catch (error) {
		logger.debug("modem usb-mode refresh failed; retaining previous map", {
			error,
		});
	}
}

/** The composition for a stable key, or `undefined` when udev did not name one. */
export function modemUsbModeForStableKey(
	stableKey: string | undefined,
): CanonicalUsbMode | undefined {
	if (stableKey === undefined || stableKey === "") return undefined;
	return usbModes.get(stableKey);
}

export function resetModemUsbModes(): void {
	usbModes = new Map();
	readUsbModes = readUsbModesFromUdev;
}
