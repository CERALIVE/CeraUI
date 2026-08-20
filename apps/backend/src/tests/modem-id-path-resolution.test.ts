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
 * The identity anchor every modem mutation fails closed on.
 *
 * Every fixture below is a VERBATIM transcription from `ceralive2`
 * (`udevadm info --export-db`, 2026-08-18), because the defect this locks was
 * invisible to a convenient fixture: the retired reader walked
 * `@ceralive/modem-control`'s `UsbDeviceSnapshot.ifname`, a field the enumerator
 * declares and never populates, so the map was empty on every real board and
 * EVERY modem mutation refused `identity_unresolved`. A test that fed the reader
 * a hand-built device list would have passed throughout.
 */

import { describe, expect, test } from "bun:test";

import { deriveModemStableKey } from "@ceraui/rpc/schemas";

import { parseNetIdPaths } from "../modules/modems/modem-id-path-source.ts";

/**
 * Verbatim `udevadm info --export-db` net records from the bench board, trimmed
 * to the keys the parser reads plus enough noise to prove it ignores them.
 *
 * `eth1` is the duplicate-MAC HiLink twin: its rename collides, so udev commits
 * no further properties and it genuinely carries NO `ID_PATH`.
 */
const BOARD_EXPORT_DB = `P: /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4/4-1.4.4:1.4/net/wwan2
M: wwan2
E: DEVPATH=/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4/4-1.4.4:1.4/net/wwan2
E: SUBSYSTEM=net
E: DEVTYPE=wwan
E: INTERFACE=wwan2
E: ID_MODEL=RM530N-GL
E: ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.4.4:1.4
E: ID_PATH_TAG=platform-xhci-hcd_0_auto-usb-0_1_4_4_1_4

P: /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.3/1-1.4.3:1.2/net/wwan1
E: SUBSYSTEM=net
E: DEVTYPE=wwan
E: INTERFACE=wwan1
E: ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.4.3:1.2

P: /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.3/1-1.3.4/1-1.3.4:1.5/net/wwan0
E: SUBSYSTEM=net
E: DEVTYPE=wwan
E: INTERFACE=wwan0
E: ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.3.4:1.5

P: /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.3/1-1.3.1/1-1.3.1:1.0/net/enx0c5b8f279a64
E: SUBSYSTEM=net
E: INTERFACE=enx0c5b8f279a64
E: ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.3.1:1.0

P: /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.2/1-1.2:1.0/net/eth1
E: SUBSYSTEM=net
E: INTERFACE=eth1
E: ID_RENAMING=1

P: /devices/platform/a41000000.pcie/pci0004:40/0004:40:00.0/0004:41:00.0/net/eth0
E: SUBSYSTEM=net
E: INTERFACE=eth0
E: ID_PATH=platform-a41000000.pcie-pci-0004:41:00.0

P: /devices/virtual/net/lo
E: SUBSYSTEM=net
E: INTERFACE=lo

P: /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: ID_MODEL=RM530N-GL
E: ID_VENDOR_ID=2c7c
E: ID_MODEL_ID=0801
E: ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.4.4
`;

describe("ifname -> ID_PATH resolution (the identity anchor)", () => {
	test("Given the board's own udev database, When parsed, Then every modem's netdev resolves an ID_PATH", () => {
		const resolved = parseNetIdPaths(BOARD_EXPORT_DB);

		expect(resolved.get("wwan2")).toBe(
			"platform-xhci-hcd.0.auto-usb-0:1.4.4:1.4",
		);
		expect(resolved.get("wwan1")).toBe(
			"platform-xhci-hcd.0.auto-usb-0:1.4.3:1.2",
		);
		expect(resolved.get("wwan0")).toBe(
			"platform-xhci-hcd.0.auto-usb-0:1.3.4:1.5",
		);
	});

	test("Given the retired reader's own input, When the usb_device records are all it is given, Then NOTHING resolves — the defect, reproduced", () => {
		// This is the whole bug: a `usb_device` record carries ID_PATH but never
		// INTERFACE, so a reader keyed on the device records answers an empty map
		// and every modem falls through to `identity_unresolved`.
		const usbDeviceRecordsOnly = BOARD_EXPORT_DB.split("\n\n")
			.filter((block) => block.includes("DEVTYPE=usb_device"))
			.join("\n\n");

		expect(usbDeviceRecordsOnly).toContain("ID_PATH=");
		expect(usbDeviceRecordsOnly).not.toContain("E: INTERFACE=");
		expect(parseNetIdPaths(usbDeviceRecordsOnly).size).toBe(0);
	});

	test("Given a netdev whose udev rename collided, When parsed, Then it is OMITTED rather than keyed on its name", () => {
		const resolved = parseNetIdPaths(BOARD_EXPORT_DB);

		expect(resolved.has("eth1")).toBe(false);
		expect(resolved.has("lo")).toBe(false);
	});

	test("Given a non-net record carrying an ID_PATH, When parsed, Then it contributes nothing", () => {
		const resolved = parseNetIdPaths(BOARD_EXPORT_DB);

		expect([...resolved.values()]).not.toContain(
			"platform-xhci-hcd.0.auto-usb-0:1.4.4",
		);
	});

	test("Given the resolved interface-level path, When reduced, Then it mints the SAME key as ModemManager's sysfs Physdev for that socket", () => {
		const fromUdev = deriveModemStableKey(
			parseNetIdPaths(BOARD_EXPORT_DB).get("wwan2"),
		);
		const fromModemManager = deriveModemStableKey(
			"/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4",
		);

		expect(fromUdev).toBe("platform-xhci-hcd.0.auto-usb-0:1.4.4");
		expect(fromModemManager).toBe(fromUdev);
	});

	test("Given empty or malformed udev output, When parsed, Then it answers an empty map rather than throwing", () => {
		expect(parseNetIdPaths("").size).toBe(0);
		expect(parseNetIdPaths("garbage\nE: no-equals-sign\n\n").size).toBe(0);
	});
});
