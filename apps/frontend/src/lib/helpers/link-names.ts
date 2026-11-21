/**
 * One name per bonded link, shared by Live, the HUD and Network.
 *
 * The same link used to read `usb0` on Live, a model and serial number on the
 * Network modem card and "HomeNetwork" in Bonded Links. A streamer names
 * links by what they are, so the name leads with that and the interface id
 * stays available as a secondary detail:
 *
 * - a modem: "SIM 1 · Northwind" (its place in the Network page's modem order,
 *   stable across re-enumeration, and the operator it is registered on), or
 *   "SIM 1" without an operator;
 * - a Wi-Fi radio joined to a network: "Wi-Fi · HomeNetwork";
 * - a Wi-Fi radio named after its MAC (`wlx…`): "USB Wi-Fi (2f27)" while it
 *   has no network;
 * - an interface named `usb<N>` (the kernel's name for an RNDIS or CDC tethered
 *   device that was not renamed): "USB tether", which says nothing about what
 *   is on the other end; MAC-named tethers keep their type label for now;
 * - anything else: the existing type label ("Ethernet", "Ethernet 2", "Wi-Fi 1").
 *
 * Pure and rune-free: the caller passes the current modem and Wi-Fi snapshots.
 */
import { m } from "@ceraui/i18n/svelte";
import type { ModemList, WifiStatus } from "@ceraui/rpc/schemas";

import { sortModemEntries } from "$lib/modem/modem-order";

const MAC_NAMED_WIFI = /^wlx[0-9a-f]{12}$/;

// Predictable names built from the MAC address (wlx…, enx…, wwx…): their
// trailing digits are part of the MAC, not an interface index, so two such
// adapters are told apart by the MAC's last four hex digits instead.
const MAC_NAMED = /^(?:wl|en|ww)x[0-9a-f]{12}$/;

/** The type label for an interface id: "Wi-Fi 1", "Ethernet 2", "Wi-Fi (2f27)". */
export const interfaceLabel = (name: string): string => {
	let numberSuffix = "";
	const number = MAC_NAMED.test(name) ? undefined : name.match(/\d+$/g)?.[0];
	if (MAC_NAMED.test(name)) {
		numberSuffix = ` (${name.slice(-4)})`;
	} else if (number) {
		numberSuffix = ` ${Number.parseInt(number, 10) + 1}`;
		name = name.slice(0, -number.length).trim();
	}

	if (name.startsWith("wl")) {
		name = m["networking.types.wifi"]();
	} else if (name.startsWith("eth") || name.startsWith("en")) {
		name = m["networking.types.ethernet"]();
	} else if (name.startsWith("ww")) {
		name = m["networking.types.modem"]();
	} else if (name.startsWith("usb")) {
		name = m["networking.types.usb"]();
	}

	return name + numberSuffix;
};

export interface LinkNameSources {
	readonly modems?: ModemList | undefined;
	readonly wifi?: WifiStatus | undefined;
}

/** The modems in the Network page's order (stable hardware port, then id). */
function modemOrder(modems: ModemList | undefined): string[] {
	return sortModemEntries(Object.entries(modems ?? {})).map(
		([key, modem]) => modem.ifname || key,
	);
}

/**
 * A Wi-Fi radio's own name, without its network: "USB Wi-Fi (2f27)" for a
 * radio named after its MAC, else the type label ("Wi-Fi 2"). Never the MAC.
 */
export function radioName(ifname: string): string {
	return MAC_NAMED_WIFI.test(ifname)
		? m["networking.linkName.usbWifi"]({ id: ifname.slice(-4) })
		: interfaceLabel(ifname);
}

export function linkName(ifname: string, sources: LinkNameSources): string {
	const modem = Object.entries(sources.modems ?? {}).find(
		([key, entry]) => (entry.ifname || key) === ifname,
	)?.[1];
	if (modem) {
		const n = modemOrder(sources.modems).indexOf(ifname) + 1;
		const operator = modem.status?.network?.trim();
		return operator
			? m["networking.linkName.simOperator"]({ n, operator })
			: m["networking.linkName.sim"]({ n });
	}

	const radio = Object.entries(sources.wifi ?? {}).find(
		([key, entry]) => (entry.ifname || key) === ifname,
	)?.[1];
	if (radio || ifname.startsWith("wl")) {
		const ssid = radio?.available?.find((network) => network.active)?.ssid;
		if (ssid) return m["networking.linkName.wifiNetwork"]({ network: ssid });
		if (MAC_NAMED_WIFI.test(ifname)) return radioName(ifname);
	}

	if (/^usb\d+$/.test(ifname)) return m["networking.linkName.usbTether"]();
	return interfaceLabel(ifname);
}

/** A namer bound to one snapshot, for lists. */
export function linkNamer(
	sources: LinkNameSources,
): (ifname: string) => string {
	return (ifname) => linkName(ifname, sources);
}
