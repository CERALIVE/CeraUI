/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

/*
  WiFi device list / status maintained by periodic ifconfig updates

  It tracks and detects changes by device name, physical (MAC) addresses and
  IPv4 address. It allows us to only update the WiFi status via nmcli when
  something has changed, because NM is very CPU / power intensive compared
  to the periodic ifconfig polling that belaUI is already doing
*/

import type { MacAddress } from "./wifi-interfaces.ts";

type WifiDeviceInfo = {
	macAddress: MacAddress;
	inetAddress: string | null;
	removed?: boolean;
};

const wifiDevices: Record<string, WifiDeviceInfo> = {};
let wifiDeviceListIsModified = false;
let wifiDeviceListIsUpdating = false;

export function wifiDeviceListStartUpdate() {
	if (wifiDeviceListIsUpdating) {
		throw "Called while an update was already in progress";
	}

	for (const macAddress of Object.values(wifiDevices)) {
		macAddress.removed = true;
	}
	wifiDeviceListIsUpdating = true;
	wifiDeviceListIsModified = false;
}

export function wifiDeviceListAdd(
	ifname: string,
	macAddress: string,
	inetAddress: string | null = null,
) {
	if (!wifiDeviceListIsUpdating) {
		throw "Called without starting an update";
	}

	if (wifiDevices[ifname]) {
		if (wifiDevices[ifname].macAddress !== macAddress) {
			wifiDevices[ifname].macAddress = macAddress;
			wifiDeviceListIsModified = true;
		}
		if (wifiDevices[ifname].inetAddress !== inetAddress) {
			wifiDevices[ifname].inetAddress = inetAddress;
			wifiDeviceListIsModified = true;
		}
		wifiDevices[ifname].removed = false;
	} else {
		wifiDevices[ifname] = {
			macAddress: macAddress,
			inetAddress: inetAddress,
		};
		wifiDeviceListIsModified = true;
	}
}

export function wifiDeviceListEndUpdate() {
	if (!wifiDeviceListIsUpdating) {
		throw "Called without starting an update";
	}

	for (const i in wifiDevices) {
		if (wifiDevices[i]?.removed) {
			delete wifiDevices[i];
			wifiDeviceListIsModified = true;
		}
	}

	wifiDeviceListIsUpdating = false;
	return wifiDeviceListIsModified;
}

export function wifiDeviceListGetMacAddress(ifname: string) {
	return wifiDevices[ifname]?.macAddress;
}

export function wifiDeviceListGetInetAddress(ifname: string) {
	return wifiDevices[ifname]?.inetAddress;
}
