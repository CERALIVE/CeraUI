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
import type { NetifEntry, NetifMessage } from "@ceraui/rpc/schemas";

/** Prefixes the modem and WiFi rosters own; loopback is nobody's. */
const MODEM_IFNAME_PREFIX = "ww";
const WIFI_IFNAME_PREFIX = "wl";

/**
 * Is this interface the Ethernet section's to render?
 *
 * Ethernet gives an interface up only when a modem row claims its name AND the
 * interface carries a cellular marker. The claim alone would let a modem row
 * that names an ordinary NIC take the board's management link off this list;
 * the marker alone would hide a device in the window before its modem row exists
 * (`netif` and `modems` arrive on different cadences), trading a duplicated row
 * for a vanished one.
 *
 * Each marker says "this interface is a cellular device's", from a different side:
 *  - `router_cellular`: a control-port-less router dongle's own netdev;
 *  - `usb_modem_net`: an MM-managed modem's data function, which ModemManager
 *    names itself, so the bench FM350-GL's RNDIS port is an `enx…` that no
 *    prefix can reach (`wwan*` is excluded by prefix above);
 *  - `dongle`: the host side (`dg<N>h`) of an isolated router dongle's veth.
 *
 * `modemRowEntry` asks the same question from the Cellular side, so an interface
 * has one listing and one bond switch.
 */
export function isWiredSectionEntry(
	name: string,
	iface: NetifEntry,
	claimedByModem: ReadonlySet<string>,
): boolean {
	if (name === "lo") return false;
	if (name.startsWith(MODEM_IFNAME_PREFIX)) return false;
	if (name.startsWith(WIFI_IFNAME_PREFIX)) return false;
	const cellularDevice = Boolean(
		iface.router_cellular || iface.usb_modem_net || iface.dongle,
	);
	return !(cellularDevice && claimedByModem.has(name));
}

/**
 * The interface a modem row may read and toggle: its own, only while Ethernet
 * does not list it. An unmarked interface that takes a retired veth's name is
 * Ethernet's, even while a stale modem frame still names it.
 */
export function modemRowEntry(
	name: string,
	netif: NetifMessage | undefined,
): NetifEntry | undefined {
	const iface = netif?.[name];
	return iface && !isWiredSectionEntry(name, iface, new Set([name]))
		? iface
		: undefined;
}

/** Interface names the modem roster currently claims, for the rule above. */
export function modemClaimedIfnames(
	modemEntries: readonly (readonly [string, { ifname: string }])[],
): ReadonlySet<string> {
	return new Set(modemEntries.map(([, modem]) => modem.ifname));
}
