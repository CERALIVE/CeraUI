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

  FALLBACK. A device with no `phy80211` node (or a non-Linux test host) resolves
  to the caller-supplied current address — i.e. exactly the pre-fix behaviour, so
  nothing regresses where the permanent address cannot be read.
*/

import { logger } from "../../helpers/logger.ts";
import { ID_RE } from "../../helpers/run.ts";
import type { MacAddress } from "../network/network-manager.ts";

/** Canonical lowercase colon-separated MAC form. */
const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const ZERO_MAC = "00:00:00:00:00:00";

/**
 * Normalize a raw MAC string to the canonical lowercase form, rejecting
 * anything malformed or all-zero (some drivers report `00:00:00:00:00:00` when
 * they have no permanent address to give).
 */
export function normalizeMacAddress(
	raw: string | undefined,
): MacAddress | undefined {
	if (!raw) return undefined;
	const mac = raw.trim().toLowerCase();
	if (!MAC_RE.test(mac) || mac === ZERO_MAC) return undefined;
	return mac;
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

/** Last successfully-read permanent address per interface name. */
const permanentMacByIfname = new Map<string, MacAddress>();
/** Interfaces already warned about, so the fallback logs once, not per poll. */
const fallbackWarned = new Set<string>();

/**
 * Resolve the stable hardware identity of a WiFi adapter.
 *
 * Resolution order: the kernel's permanent address → the last permanent address
 * successfully read for this interface → the caller's current (possibly
 * randomized) address. The cached tier matters: a transient sysfs read failure
 * must not re-key the adapter registry onto a scan-time address for one poll.
 */
export async function resolveWifiPermanentMac(
	ifname: string,
	currentMac: MacAddress,
): Promise<MacAddress> {
	const resolved = normalizeMacAddress(await activeReader(ifname));
	if (resolved) {
		if (permanentMacByIfname.get(ifname) !== resolved) {
			permanentMacByIfname.set(ifname, resolved);
			fallbackWarned.delete(ifname);
		}
		return resolved;
	}

	const cached = permanentMacByIfname.get(ifname);
	if (cached) return cached;

	if (!fallbackWarned.has(ifname)) {
		fallbackWarned.add(ifname);
		logger.warn(
			`Could not read the permanent MAC address of ${ifname}; falling back to its current address. Hotspot identity may change if NetworkManager randomizes it.`,
		);
	}
	return currentMac.toLowerCase();
}

/** The last permanent address resolved for `ifname`, if any. */
export function getWifiPermanentMacCached(
	ifname: string,
): MacAddress | undefined {
	return permanentMacByIfname.get(ifname);
}

/** Drop cached entries for interfaces that are no longer present. */
export function retainWifiPermanentMacs(ifnames: Iterable<string>): void {
	const keep = new Set(ifnames);
	for (const ifname of [...permanentMacByIfname.keys()]) {
		if (!keep.has(ifname)) {
			permanentMacByIfname.delete(ifname);
			fallbackWarned.delete(ifname);
		}
	}
}

/** Test seam: clear all cached permanent addresses. */
export function resetWifiPermanentMacCache(): void {
	permanentMacByIfname.clear();
	fallbackWarned.clear();
}
