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
 * Which section of the Network destination owns a given interface — pure,
 * rune-free, so the rule can be tested without mounting the view.
 *
 * The rule matters more than it looks: an interface appearing in NEITHER
 * section is a device that silently vanished, and one appearing in BOTH is a
 * device with two bond toggles that can disagree. Exactly one section owns each.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";

/** Prefixes the modem and WiFi rosters own; loopback is nobody's. */
const MODEM_IFNAME_PREFIX = "ww";
const WIFI_IFNAME_PREFIX = "wl";

/**
 * Is this interface the Ethernet section's to render?
 *
 * A CLAIM by a modem row is the whole rule: `netif` and `modems` are independent
 * broadcasts on different cadences, so dropping a row the moment some classifier
 * marker appears would hide the device in the window before its modem row
 * exists — a duplicated row traded for a disappeared one. The claim is the
 * handover signal, and it is the ONLY thing that moves a row.
 *
 * The claim alone is NOT enough — the row must ALSO carry a classifier marker
 * proving the interface belongs to a cellular device, so a modem row naming an
 * ordinary NIC can never take the board's management link off this list.
 *
 * There are TWO such markers, and the second is why this rule changed.
 * `router_cellular` covers a control-port-less dongle. `usb_modem_net` covers an
 * MM-MANAGED modem's own data function: ModemManager names its net port itself
 * (`mmcli -m 4` → `ports: enx000011121314 (net), ttyUSB12 (at)`), so the bench
 * Fibocom FM350-GL — whose data path is RNDIS — hands the registration an `enx…`
 * name and gets a full Cellular row. Without the second marker that same
 * physical device also rendered a bare, unexplained Ethernet row. `wwan*`
 * modems never needed this because the prefix test above already excludes them;
 * an RNDIS interface is named after its MAC and no prefix can reach it.
 */
export function isWiredSectionEntry(
	name: string,
	iface: NetifEntry,
	claimedByModem: ReadonlySet<string>,
): boolean {
	if (name === "lo") return false;
	if (name.startsWith(MODEM_IFNAME_PREFIX)) return false;
	if (name.startsWith(WIFI_IFNAME_PREFIX)) return false;
	const cellularDevice = Boolean(iface.router_cellular || iface.usb_modem_net);
	return !(cellularDevice && claimedByModem.has(name));
}

/** Interface names the modem roster currently claims, for the rule above. */
export function modemClaimedIfnames(
	modemEntries: readonly (readonly [string, { ifname: string }])[],
): ReadonlySet<string> {
	return new Set(modemEntries.map(([, modem]) => modem.ifname));
}
