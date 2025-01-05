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

type WifiDeviceHardwareAddress = {
	hwAddr: string;
	inetAddr: string | null;
	removed?: boolean;
};

const wifiDeviceHwAddr: Record<string, WifiDeviceHardwareAddress> = {};
let wiFiDeviceListIsModified = false;
let wiFiDeviceListIsUpdating = false;

export function wiFiDeviceListStartUpdate() {
	if (wiFiDeviceListIsUpdating) {
		throw "Called while an update was already in progress";
	}

	for (const i in wifiDeviceHwAddr) {
		wifiDeviceHwAddr[i]!.removed = true;
	}
	wiFiDeviceListIsUpdating = true;
	wiFiDeviceListIsModified = false;
}

export function wiFiDeviceListAdd(
	ifname: string,
	hwAddr: string,
	inetAddr: string | null = null,
) {
	if (!wiFiDeviceListIsUpdating) {
		throw "Called without starting an update";
	}

	if (wifiDeviceHwAddr[ifname]) {
		if (wifiDeviceHwAddr[ifname].hwAddr !== hwAddr) {
			wifiDeviceHwAddr[ifname].hwAddr = hwAddr;
			wiFiDeviceListIsModified = true;
		}
		if (wifiDeviceHwAddr[ifname].inetAddr !== inetAddr) {
			wifiDeviceHwAddr[ifname].inetAddr = inetAddr;
			wiFiDeviceListIsModified = true;
		}
		wifiDeviceHwAddr[ifname].removed = false;
	} else {
		wifiDeviceHwAddr[ifname] = {
			hwAddr,
			inetAddr,
		};
		wiFiDeviceListIsModified = true;
	}
}

export function wiFiDeviceListEndUpdate() {
	if (!wiFiDeviceListIsUpdating) {
		throw "Called without starting an update";
	}

	for (const i in wifiDeviceHwAddr) {
		if (wifiDeviceHwAddr[i]?.removed) {
			delete wifiDeviceHwAddr[i];
			wiFiDeviceListIsModified = true;
		}
	}

	wiFiDeviceListIsUpdating = false;
	return wiFiDeviceListIsModified;
}

export function wifiDeviceListGetHwAddr(ifname: string) {
	if (wifiDeviceHwAddr[ifname]) {
		return wifiDeviceHwAddr[ifname].hwAddr;
	}
}

export function wifiDeviceListGetInetAddr(ifname: string) {
	if (wifiDeviceHwAddr[ifname]) {
		return wifiDeviceHwAddr[ifname].inetAddr;
	}
}
