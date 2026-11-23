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

/*
  Permanent (hardware) MAC address resolution for WiFi adapters.

  WHY THIS EXISTS. NetworkManager randomizes a WiFi device's OPERATIONAL MAC
  while scanning (`wifi.scan-rand-mac-address`, enabled by default), and restores
  the real one when it activates a connection. `ifconfig`/`ip link`/nmcli's
  `GENERAL.HWADDR` all report that operational address, so the value CeraUI used
  to key every adapter on changed several times an hour. Two things broke:

    - the adapter registry (`wifiInterfacesByMacAddress`) re-keyed itself, so an
      adapter's adopted hotspot profile, saved-connection map and numeric id were
      silently discarded and rebuilt from empty; and
    - `802-11-wireless.mac-address` — which NetworkManager matches against the
      device's PERMANENT address, never its current one — was pinned to whatever
      randomized value happened to be live, producing profiles no device can ever
      activate ("device MAC address does not match the profile").

  WHERE THE PERMANENT ADDRESS COMES FROM. `/sys/class/net/<ifname>/phy80211/
  macaddress` is the cfg80211 wiphy's `perm_addr` — the radio's real, immutable
  hardware address. It is a single file read (no spawn, no new allowed binary)
  and was verified byte-equal to NetworkManager's own D-Bus `PermHwAddress`
  property on the reference RK3588 board.

  An unreadable address stays unresolved. Only the coherent lifetime producer
  may reuse a prior address, with the same ifindex, wiphy and phy path.
*/

import { normalizeMacAddress } from "@ceraui/rpc";
import { ID_RE } from "../../helpers/run.ts";
import type { MacAddress } from "../network/network-manager.ts";

export { normalizeMacAddress };

/** Registry/store keys may carry a literal, case-sensitive port after the MAC. */
export function wifiAdapterKeyMac(key: string): MacAddress | undefined {
	return normalizeMacAddress(key.split("@", 1)[0]);
}

export function normalizeWifiAdapterKey(key: string): string {
	const separator = key.indexOf("@");
	const mac = wifiAdapterKeyMac(key);
	if (!mac) return key.trim().toLowerCase();
	return separator < 0 ? mac : mac + key.slice(separator);
}

export function wifiAdapterKeyPort(key: string): string | undefined {
	const separator = key.indexOf("@");
	return separator < 0 || !wifiAdapterKeyMac(key)
		? undefined
		: key.slice(separator + 1);
}

/** sysfs node exposing the radio's `wiphy->perm_addr`. */
export function permanentMacSysfsPath(ifname: string): string {
	return `/sys/class/net/${ifname}/phy80211/macaddress`;
}

export type PermanentMacReader = (
	ifname: string,
) => Promise<string | undefined>;

const readPermanentMacFromSysfs: PermanentMacReader = async (ifname) => {
	// `ifname` comes from nmcli output; validate before interpolating a path.
	if (!ID_RE.test(ifname)) return undefined;
	try {
		return await Bun.file(permanentMacSysfsPath(ifname)).text();
	} catch {
		// No phy80211 node (non-cfg80211 driver) or an unreadable sysfs tree.
		return undefined;
	}
};

let activeReader: PermanentMacReader = readPermanentMacFromSysfs;

/** Test seam (mirrors the other `set*Runner` seams). Pass `null` to restore. */
export function setPermanentMacReaderForTest(
	reader: PermanentMacReader | null,
): void {
	activeReader = reader ?? readPermanentMacFromSysfs;
}

/**
 * Read only the kernel permanent address. Discovery uses the bracketed
 * WifiRadioIdentityProducer sample, never an ifname or operational-MAC cache.
 */
export async function resolveWifiPermanentMac(
	ifname: string,
	_currentMac: MacAddress,
): Promise<MacAddress | undefined> {
	return normalizeMacAddress(await activeReader(ifname));
}
