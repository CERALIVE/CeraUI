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
 * PURE reading of `udevadm monitor --property --udev` output.
 *
 * This is the ATTACH signal behind the optimistic "Modem detected" row. It runs
 * far ahead of ModemManager: the kernel publishes a `usb_device` add the instant
 * enumeration completes, while MM has to probe ports, talk to the modem, and
 * only then export it on the bus. Everything between those two moments is time
 * an operator currently spends looking at a device list that does not mention
 * the stick they just plugged in.
 *
 * THREE THINGS ARE DELIBERATE HERE.
 *
 * 1. **The BLOCK is read by its PROPERTIES, never by the header line.** Each
 *    event `udevadm monitor --property` prints is a human-readable header
 *    (`UDEV  [123.456] add   /devices/… (usb)`) followed by `KEY=VALUE` lines
 *    and a blank line. The header's spacing and timestamp format are a display
 *    detail; `ACTION=`, `DEVPATH=`, `SUBSYSTEM=` and `DEVTYPE=` are properties
 *    the tool contracts to emit. Parsing the header would key the whole feature
 *    on the one line udev is free to reformat.
 *
 * 2. **Only `DEVTYPE=usb_device` is considered.** A composite modem publishes
 *    one `usb_device` and several `usb_interface` children (plus tty / net /
 *    usbmisc children as drivers bind), so keying on anything else fires three
 *    to seven times for one physical stick. The `usb_device` is also the ONLY
 *    node that carries `ID_PATH`, `ID_SERIAL_SHORT` and `ID_USB_INTERFACES` —
 *    the exact facts todo 10's identity ladder wants — verified against real
 *    `udevadm info` output rather than assumed.
 *
 * 3. **An `ID_PATH` is REQUIRED, not preferred.** A provisional row exists only
 *    to be REPLACED by the authoritative one, and the wire's `stable_key`
 *    (`deriveModemStableKey(ID_PATH)`) is the key both sides always carry, so a
 *    device with no `ID_PATH` is one whose provisional row could never be proven
 *    to merge. Publishing it would create exactly the ghost class this todo is
 *    required not to introduce, so it is dropped instead.
 */

import { CELLULAR_USB_VENDOR_IDS } from "../network/usb-net-classifier.ts";

/** One decoded `udevadm monitor --property` block. */
export interface UdevPropertyEvent {
	readonly action: string;
	readonly properties: ReadonlyMap<string, string>;
}

/** The facts a `usb_device` add gives us about a cellular-class attachment. */
export interface UdevCellularAttach {
	/** udev `ID_PATH` of the physical device — the anchor everything keys on. */
	readonly idPath: string;
	readonly vid?: string;
	readonly pid?: string;
	readonly serial?: string;
	/** `ID_VENDOR_FROM_DATABASE` / `ID_MODEL_FROM_DATABASE` (hwdb enrichment). */
	readonly hwdbVendor?: string;
	readonly hwdbModel?: string;
	/** Which signal made this device eligible — recorded, never guessed. */
	readonly evidence: string;
}

// ── USB-IF interface classes that indicate a cellular data function ──────────
// Mirrors `usb-net-classifier.ts`'s codes; `ID_USB_INTERFACES` publishes the
// same descriptor bytes as `:CCSSPP:` triplets, so the two tables must agree.
const CLASS_COMM = "02"; // CDC communications (ECM / NCM / MBIM control)
const CLASS_CDC_DATA = "0a";
const CLASS_WIRELESS = "e0"; // wireless controller — RNDIS lives here
const CLASS_VENDOR = "ff"; // QMI / AT composites are vendor-specific

const CELLULAR_INTERFACE_CLASSES: ReadonlySet<string> = new Set([
	CLASS_COMM,
	CLASS_CDC_DATA,
	CLASS_WIRELESS,
	CLASS_VENDOR,
]);

/**
 * Decode one block of `KEY=VALUE` lines.
 *
 * A block with no `ACTION` is not an event (the tool's own two-line preamble is
 * the common case), so it answers `undefined` rather than an empty event.
 */
export function parseUdevPropertyBlock(
	lines: readonly string[],
	defaultAction?: string,
): UdevPropertyEvent | undefined {
	const properties = new Map<string, string>();
	for (const line of lines) {
		const propertyLine = line.startsWith("E: ") ? line.slice(3) : line;
		const separator = propertyLine.indexOf("=");
		if (separator <= 0) {
			continue;
		}
		const key = propertyLine.slice(0, separator).trim();
		// A property VALUE may legitimately contain `=`; only the FIRST one
		// separates. Trailing whitespace is display padding, never data.
		if (key.length > 0 && !properties.has(key)) {
			properties.set(key, propertyLine.slice(separator + 1).trimEnd());
		}
	}
	const action = properties.get("ACTION") ?? defaultAction;
	return action === undefined ? undefined : { action, properties };
}

export function cellularAttachesFromUdevDatabase(
	exportDb: string,
): readonly UdevCellularAttach[] {
	const attaches: UdevCellularAttach[] = [];
	for (const block of exportDb.split(/\n\s*\n/)) {
		const event = parseUdevPropertyBlock(block.split("\n"), "add");
		if (event === undefined) continue;
		const attach = cellularAttachFromUdev(event);
		if (attach !== undefined) attaches.push(attach);
	}
	return attaches;
}

function isUsbDevice(event: UdevPropertyEvent): boolean {
	return (
		event.properties.get("SUBSYSTEM") === "usb" &&
		event.properties.get("DEVTYPE") === "usb_device"
	);
}

function trimmed(
	event: UdevPropertyEvent,
	key: string,
	lower = false,
): string | undefined {
	const raw = event.properties.get(key)?.trim();
	if (raw === undefined || raw.length === 0) {
		return undefined;
	}
	return lower ? raw.toLowerCase() : raw;
}

/**
 * Does `ID_USB_INTERFACES` name a function a cellular device would expose?
 *
 * The property is `:CCSSPP:CCSSPP:` — one triplet per interface descriptor. A
 * match is NOT a classification: hubs, audio devices and HID receivers all
 * publish their own classes, and none of those appear in the set above. It is
 * one of two independent eligibility signals, both of which stay deliberately
 * WIDE, because the cost of a wrong positive here is a provisional row that
 * times out unseen — where a wrong negative is the whole feature not firing for
 * the device an operator just plugged in.
 */
function hasCellularInterfaceClass(interfaces: string): boolean {
	for (const triplet of interfaces.split(":")) {
		if (triplet.length !== 6) {
			continue;
		}
		if (CELLULAR_INTERFACE_CLASSES.has(triplet.slice(0, 2).toLowerCase())) {
			return true;
		}
	}
	return false;
}

/**
 * Why this device is eligible for a provisional row, or `undefined`.
 *
 * Precedence is by STRENGTH of the claim: the image's own ModemManager udev tag
 * is a statement someone made about this exact hardware, a known cellular vendor
 * id is a statement about the silicon, and an interface class is the weakest —
 * a shape a cellular device has, which other devices also have.
 */
function cellularEligibility(event: UdevPropertyEvent): string | undefined {
	// `ID_MM_DEVICE_PROCESS` / `ID_MM_CANDIDATE` are set by the device image's
	// own quirk rules for modem vendor ids, so a device carrying one has already
	// been named a modem by the layer that owns that decision.
	for (const tag of ["ID_MM_DEVICE_PROCESS", "ID_MM_CANDIDATE"] as const) {
		if (event.properties.get(tag) === "1") {
			return `udev tag ${tag}=1`;
		}
	}

	const vid = trimmed(event, "ID_VENDOR_ID", true);
	const vendorName =
		vid === undefined ? undefined : CELLULAR_USB_VENDOR_IDS.get(vid);
	if (vid !== undefined && vendorName !== undefined) {
		return `USB vendor ${vid} is ${vendorName}, a cellular-module vendor`;
	}

	const interfaces = trimmed(event, "ID_USB_INTERFACES");
	if (interfaces !== undefined && hasCellularInterfaceClass(interfaces)) {
		return `USB interface classes ${interfaces} include a cellular data function`;
	}

	return undefined;
}

/**
 * The attach facts for a cellular-class `usb_device` add, or `undefined`.
 *
 * `bind`/`change` are deliberately NOT accepted: a composite modem emits several
 * of each as its drivers settle, and every one of them describes a device that
 * is already present. `add` is the one edge that means "this was not here a
 * moment ago", which is the only thing an optimistic row may claim.
 */
export function cellularAttachFromUdev(
	event: UdevPropertyEvent,
): UdevCellularAttach | undefined {
	if (event.action !== "add" || !isUsbDevice(event)) {
		return undefined;
	}
	const idPath = trimmed(event, "ID_PATH");
	if (idPath === undefined) {
		return undefined;
	}
	const evidence = cellularEligibility(event);
	if (evidence === undefined) {
		return undefined;
	}
	return {
		idPath,
		evidence,
		...optional("vid", trimmed(event, "ID_VENDOR_ID", true)),
		...optional("pid", trimmed(event, "ID_MODEL_ID", true)),
		...optional("serial", trimmed(event, "ID_SERIAL_SHORT")),
		...optional("hwdbVendor", trimmed(event, "ID_VENDOR_FROM_DATABASE")),
		...optional("hwdbModel", trimmed(event, "ID_MODEL_FROM_DATABASE")),
	};
}

/**
 * The `ID_PATH` of a `usb_device` remove, or `undefined`.
 *
 * A detach is NOT filtered through {@link cellularEligibility}, and that
 * asymmetry is the point: udev strips most `ID_*` properties from a remove
 * event, so re-testing eligibility there would refuse to retire the very rows
 * this module created. Removing by path is safe because a path we never added
 * simply is not in the store.
 */
export function detachIdPathFromUdev(
	event: UdevPropertyEvent,
): string | undefined {
	if (event.action !== "remove" || !isUsbDevice(event)) {
		return undefined;
	}
	return trimmed(event, "ID_PATH");
}

function optional<K extends string>(
	key: K,
	value: string | undefined,
): Record<K, string> | Record<string, never> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
