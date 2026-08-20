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
 * WHICH NetworkManager device a modem's data interface belongs to.
 *
 * A MODEM'S NETDEV IS NOT AN NM DEVICE. NetworkManager represents an
 * MM-managed modem as one `NMDeviceModem` named after ModemManager's PRIMARY
 * PORT, and reports the netdev the bearer landed on as that device's
 * `GENERAL.IP-IFACE`. Board-measured on `ceralive2` (Quectel RM530N-GL,
 * 2026-08-19):
 *
 *   nmcli -g GENERAL.CON-UUID device show wwan2     -> Error: Device 'wwan2' not found.
 *   nmcli -g GENERAL.IP-IFACE  device show cdc-wdm2 -> wwan2
 *   nmcli -g GENERAL.CON-UUID  device show cdc-wdm2 -> 6832198b-…
 *
 * That is the whole of BLOCKER B7. The USB-mode transition asked NM for the
 * modem's connection by its NETDEV name, got nothing back, and reported the
 * miss as `identity_unresolved` — for a device whose identity the pure-read
 * options path had resolved successfully seconds earlier, because that path
 * never asks NM anything. The identity resolver was never the divergence; this
 * ifname-keyed NM lookup was, and BOTH of the transition's NM-touching steps
 * (the connection id it hands the engine, and the post-switch data-path
 * confirmation) carried it.
 *
 * So this is the ONE resolver both of those steps route through. It is keyed on
 * the netdev name because that is what every caller already holds — including
 * AFTER the switch, where the engine reports a NEW netdev and the modem's MM
 * index has been re-issued.
 *
 * The direct arm is not a fallback for tidiness: a router-mode or RNDIS/ECM
 * modem whose netdev NM manages under its own name resolves to itself, and
 * `undefined` stays a first-class answer for a device NM does not know at all.
 */

import { nmDeviceProp, nmDevices } from "../network/network-manager.ts";

/**
 * The NM device types that can front a modem. The IP-IFACE probe is restricted
 * to these so a board full of ethernet dongles costs one `device status` read
 * rather than one `device show` per interface.
 */
const MODEM_NM_DEVICE_TYPES: ReadonlySet<string> = new Set(["gsm", "cdma"]);

/** The two reads this resolver needs, injectable for tests (`set*ForTest`). */
export interface ModemNmDeviceReader {
	/** `nmcli -t -f DEVICE,TYPE device status` rows, `<device>:<type>`. */
	listDevices(): Promise<readonly string[] | undefined>;
	/** `nmcli --get-values <fields> device show <device>`, one entry per field. */
	deviceProp(
		device: string,
		fields: string,
	): Promise<readonly string[] | undefined>;
}

const defaultReader: ModemNmDeviceReader = {
	listDevices: () => nmDevices("DEVICE,TYPE"),
	deviceProp: (device, fields) => nmDeviceProp(device, fields),
};

let activeReader: ModemNmDeviceReader | undefined;

/** Test seam (the `set*ForTest` convention). `null` restores the real reads. */
export function setModemNmDeviceReaderForTest(
	reader: ModemNmDeviceReader | null,
): void {
	activeReader = reader ?? undefined;
}

/**
 * Resolve the NM device that carries `ifname`.
 *
 * The device list is read FIRST and membership tested against it, deliberately
 * rather than probing `ifname` directly: `nmcli device show <unknown>` exits
 * non-zero, and the data-path confirmation calls this once per poll for up to
 * 90 s — a direct probe would write ~45 error lines per transition for the
 * ordinary, correct case.
 */
export async function resolveModemNmDevice(
	ifname: string,
): Promise<string | undefined> {
	if (ifname === "") return undefined;

	const reader = activeReader ?? defaultReader;
	const rows = await reader.listDevices();
	if (rows === undefined) return undefined;

	const candidates: string[] = [];
	for (const row of rows) {
		const [device, type] = row.split(":");
		if (device === undefined || device === "") continue;
		// NM manages this netdev under its own name (an ethernet-class dongle, or
		// a modem whose data function NM drives directly).
		if (device === ifname) return ifname;
		if (type !== undefined && MODEM_NM_DEVICE_TYPES.has(type)) {
			candidates.push(device);
		}
	}

	for (const device of candidates) {
		const carried = (await reader.deviceProp(device, "GENERAL.IP-IFACE"))?.[0];
		if (carried?.trim() === ifname) return device;
	}
	return undefined;
}

/**
 * Resolve the post-re-enumeration NM modem device that can carry a saved
 * connection. `GENERAL.CON-UUID` covers an already reactivated profile;
 * `GENERAL.AVAILABLE-CONNECTIONS` breaks the activation chicken-and-egg when the
 * new NM device exists but the transaction still needs to bring the profile up.
 */
export async function resolveModemNmDeviceForConnection(
	connectionId: string,
): Promise<string | undefined> {
	if (connectionId === "") return undefined;

	const reader = activeReader ?? defaultReader;
	const rows = await reader.listDevices();
	if (rows === undefined) return undefined;

	for (const row of rows) {
		const [device, type] = row.split(":");
		if (
			device === undefined ||
			device === "" ||
			type === undefined ||
			!MODEM_NM_DEVICE_TYPES.has(type)
		) {
			continue;
		}
		const values = await reader.deviceProp(
			device,
			"GENERAL.CON-UUID,GENERAL.AVAILABLE-CONNECTIONS",
		);
		if (
			values?.some((value) => {
				const normalized = value.trim();
				return (
					normalized === connectionId ||
					(normalized.startsWith(connectionId) &&
						/\s/.test(normalized.charAt(connectionId.length)))
				);
			}) === true
		) {
			return device;
		}
	}
	return undefined;
}

/**
 * Read NM properties of an already-resolved device through the SAME seam as the
 * resolution above, so a caller cannot resolve the device one way and read it
 * another.
 */
export function readModemNmDeviceProp(
	device: string,
	fields: string,
): Promise<readonly string[] | undefined> {
	return (activeReader ?? defaultReader).deviceProp(device, fields);
}
