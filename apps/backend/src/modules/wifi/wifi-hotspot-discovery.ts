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

import { logger } from "../../helpers/logger.ts";
import {
	type ConnectionUUID,
	type MacAddress,
	nmConnDelete,
	nmConnGetFields,
	nmConnSetFields,
	nmConnSetWifiMacAddress,
	nmConnsGet,
	nmcliParseSep,
} from "../network/network-manager.ts";
import {
	getHotspotCredentials,
	type HotspotCredentials,
	rememberHotspotCredentials,
} from "./hotspot-credentials.ts";
import { channelFromNM } from "./wifi-channels.ts";
import {
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
} from "./wifi-connections.ts";
import { canHotspot, type ExistingHotspotConn } from "./wifi-hotspot-types.ts";

// ─── NM connection discovery (hotspot bootstrap) ─────────────────────────────

export type HotspotAdoptionOptions = {
	/**
	 * NetworkManager reports this profile as the radio's ACTIVE connection, so it
	 * is what the adapter is actually broadcasting and outranks the persisted
	 * identity. The saved-connection sweep sets this false: it walks every AP
	 * profile in nmcli order, and without the persisted identity to arbitrate,
	 * whichever duplicate happened to be enumerated first would become the
	 * adapter's hotspot — which is how a restart changed the SSID out from under
	 * an operator's phone.
	 */
	active?: boolean;
};

/**
 * Whether an AP profile may claim an adapter. The persisted identity is the
 * tie-breaker between duplicate profiles; only the connection NetworkManager is
 * actually running overrides it.
 */
export function shouldAdoptHotspotConn(
	uuid: ConnectionUUID,
	stored: HotspotCredentials | undefined,
	options: HotspotAdoptionOptions = {},
): boolean {
	if (options.active) return true;
	return !stored?.conn || stored.conn === uuid;
}

export async function handleHotspotConn(
	macAddress_: string | undefined,
	uuid: string,
	options: HotspotAdoptionOptions = {},
) {
	/*
	  A profile's pinned `802-11-wireless.mac-address` is only a usable adapter key
	  while it holds a PERMANENT address. Profiles written before that was enforced
	  carry a scan-time randomized address that matches no present adapter, so fall
	  back to the ifname/active-connection match rather than dropping the profile.
	*/
	const pinned =
		macAddress_ && getWifiInterfaceByMacAddress(macAddress_)
			? macAddress_
			: undefined;
	const macAddress = pinned || (await findMacAddressForConnection(uuid));
	if (!macAddress) {
		return;
	}

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) {
		logger.warn("Can not update hotspot connection, interface not found");
		return;
	}

	if (!canHotspot(wifiInterface)) {
		logger.warn(
			"Can not update hotspot connection, interface does not support hotspot",
		);
		return;
	}

	if (
		// Interface already has a different hotspot connection
		wifiInterface.hotspot.conn &&
		wifiInterface.hotspot.conn !== uuid
	) {
		logger.warn(
			"Can not update hotspot connection, interface already has an active connection",
		);
		return;
	}

	if (
		!shouldAdoptHotspotConn(uuid, getHotspotCredentials(macAddress), options)
	) {
		// Another profile is this adapter's persisted identity — keep this
		// duplicate from auto-starting and from claiming the adapter.
		await nmConnSetFields(uuid, { "connection.autoconnect": "no" });
		return;
	}

	/*
    we expect and will update automatically:
    connection.autoconnect-priority: 999

    we expect these settings, otherwise will mark as modified connections:
    802-11-wireless.hidden=no
    802-11-wireless-security.key-mgmt=wpa-psk
    802-11-wireless-security.pairwise=ccmp
    802-11-wireless-security.group=ccmp
    802-11-wireless-security.proto=rsn
    802-11-wireless-security.pmf=1 (disable) - disables requiring WPA3 Protected Management Frames for compatibility
  */
	const settingsFields = [
		"connection.autoconnect-priority",
		"802-11-wireless.ssid",
		"802-11-wireless-security.psk",
		"802-11-wireless.band",
		"802-11-wireless.channel",
	] as const;
	const checkFields = [
		"802-11-wireless.hidden",
		"802-11-wireless-security.key-mgmt",
		"802-11-wireless-security.pairwise",
		"802-11-wireless-security.group",
		"802-11-wireless-security.proto",
		"802-11-wireless-security.pmf",
	] as const;

	const fields = await nmConnGetFields(uuid, [
		...settingsFields,
		...checkFields,
		"802-11-wireless.mac-address",
	] as const);

	if (fields === undefined) return;

	/* If the connection doesn't have maximum priority, update it
     This is required to ensure the hotspot is started even if the Wifi
     networks for some matching client connections are available
  */
	if (fields[0] !== "999") {
		await nmConnSetFields(uuid, { "connection.autoconnect-priority": "999" });
	}

	/*
	  Repair a profile bound to anything other than the adapter's permanent
	  address. NetworkManager matches this property against the PERMANENT address,
	  so a profile carrying a randomized one can never be activated again.
	*/
	if (fields[11].toLowerCase() !== macAddress) {
		await nmConnSetWifiMacAddress(uuid, macAddress);
	}

	wifiInterface.hotspot.conn = uuid;
	wifiInterface.hotspot.name = fields[1];
	wifiInterface.hotspot.password = fields[2];
	wifiInterface.hotspot.channel = channelFromNM(fields[3], fields[4]);

	rememberHotspotCredentials(macAddress, {
		ssid: fields[1],
		password: fields[2],
		conn: uuid,
		channel: wifiInterface.hotspot.channel,
	});

	if (
		fields[5] !== "no" ||
		fields[6] !== "wpa-psk" ||
		fields[7] !== "ccmp" ||
		fields[8] !== "ccmp" ||
		fields[9] !== "rsn" ||
		fields[10] !== "1"
	) {
		wifiInterface.hotspot.warnings.modified = true;
	}
}

async function findMacAddressForConnection(uuid: string) {
	// Check if the connection is in use for any wifi interface
	const connIfName = (
		await nmConnGetFields(uuid, ["connection.interface-name"] as const)
	)?.[0];

	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];

		if (
			!wifiInterface ||
			!canHotspot(wifiInterface) ||
			(wifiInterface.hotspot.conn !== uuid &&
				wifiInterface.ifname !== connIfName)
		) {
			continue;
		}

		// If we can match the connection against a certain interface
		if (!wifiInterface.hotspot.conn) {
			// And if this interface doesn't already have a hotspot connection
			// Try to update the connection to match the MAC address
			if (await nmConnSetWifiMacAddress(uuid, macAddress)) {
				wifiInterface.hotspot.conn = uuid;
				return macAddress;
			}
		} else {
			// If the interface already has a hotspot connection, then disable autoconnect
			await nmConnSetFields(uuid, { "connection.autoconnect": "no" });
		}

		break;
	}

	return undefined;
}

// ─── deterministic profile lookup + duplicate consolidation ──────────────────

const AP_PROFILE_FIELDS = [
	"802-11-wireless.mode",
	"802-11-wireless.ssid",
	"802-11-wireless-security.psk",
	"802-11-wireless.band",
	"802-11-wireless.channel",
	"802-11-wireless.mac-address",
] as const;

type ApProfile = ExistingHotspotConn & { macAddress: MacAddress };

/** `mode, ssid, psk, band, channel, mac-address` — mirrors AP_PROFILE_FIELDS. */
type ApProfileFieldValues = readonly [
	string,
	string,
	string,
	string,
	string,
	string,
];

export type HotspotProfileDeps = {
	getApProfileFields: (
		uuid: ConnectionUUID,
	) => Promise<ApProfileFieldValues | undefined>;
	listConnections: (fields: string) => Promise<string[] | undefined>;
	deleteConnection: (uuid: ConnectionUUID) => Promise<boolean>;
};

export const defaultHotspotProfileDeps: HotspotProfileDeps = {
	getApProfileFields: (uuid) => nmConnGetFields(uuid, AP_PROFILE_FIELDS),
	listConnections: nmConnsGet,
	deleteConnection: nmConnDelete,
};

async function readApProfile(
	uuid: ConnectionUUID,
	deps: HotspotProfileDeps,
): Promise<ApProfile | undefined> {
	const fields = await deps.getApProfileFields(uuid);
	if (fields === undefined) return undefined;
	if (fields[0] !== "ap" || !fields[1]) return undefined;

	return {
		uuid,
		ssid: fields[1],
		password: fields[2],
		channel: channelFromNM(fields[3], fields[4]),
		macAddress: fields[5].toLowerCase(),
	};
}

async function listWirelessConns(
	fields: string,
	deps: HotspotProfileDeps,
): Promise<Array<string[]> | undefined> {
	const rows = await deps.listConnections(fields);
	if (rows === undefined) return undefined;
	return rows.map((row) => nmcliParseSep(row));
}

/**
 * Resolve the NetworkManager AP profile that belongs to `macAddress` (an adapter
 * PERMANENT address).
 *
 * Deterministic by construction: the persisted UUID is checked first, then the
 * profile whose `802-11-wireless.mac-address` binds it to this exact adapter.
 * The persisted SSID is only a last resort, for a profile CeraUI created before
 * the MAC binding was trustworthy.
 */
export async function findHotspotConnForAdapter(
	macAddress: MacAddress,
	stored: HotspotCredentials | undefined,
	deps: HotspotProfileDeps = defaultHotspotProfileDeps,
): Promise<ExistingHotspotConn | undefined> {
	if (stored?.conn) {
		const profile = await readApProfile(stored.conn, deps);
		if (profile) return profile;
	}

	const rows = await listWirelessConns("uuid,type", deps);
	if (!rows) return undefined;

	let ssidMatch: ExistingHotspotConn | undefined;
	for (const [uuid, type] of rows) {
		if (!uuid || type !== "802-11-wireless") continue;
		const profile = await readApProfile(uuid, deps);
		if (!profile) continue;
		if (profile.macAddress === macAddress) return profile;
		if (stored && profile.ssid === stored.ssid) ssidMatch ??= profile;
	}

	return ssidMatch;
}

/**
 * `nmcli device wifi hotspot` names the profile it creates `Hotspot`, then
 * `Hotspot-1`, `Hotspot-2`, … A profile carrying that generated id, in AP mode,
 * that no adapter is using is a superseded CeraUI hotspot — the only kind this
 * prunes.
 */
const GENERATED_HOTSPOT_ID_RE = /^Hotspot(?:-\d+)?$/;

function collectConnsInUse(): Set<ConnectionUUID> {
	const inUse = new Set<ConnectionUUID>();
	for (const wifiInterface of Object.values(getWifiInterfacesByMacAddress())) {
		if (!wifiInterface) continue;
		if (wifiInterface.conn) inUse.add(wifiInterface.conn);
		if (wifiInterface.activeConn) inUse.add(wifiInterface.activeConn);
		if (canHotspot(wifiInterface) && wifiInterface.hotspot.conn) {
			inUse.add(wifiInterface.hotspot.conn);
		}
	}
	return inUse;
}

/** UUIDs another present adapter has claimed as its own hotspot identity. */
function collectConnsReservedByOtherAdapters(
	macAddress: MacAddress,
): Set<ConnectionUUID> {
	const reserved = new Set<ConnectionUUID>();
	for (const mac of Object.keys(getWifiInterfacesByMacAddress())) {
		if (mac === macAddress) continue;
		const conn = getHotspotCredentials(mac)?.conn;
		if (conn) reserved.add(conn);
	}
	return reserved;
}

/**
 * Delete superseded hotspot profiles so exactly one survives per adapter. Best
 * effort — a failure here never fails a hotspot start.
 *
 * A profile is only removed when it is provably THIS adapter's leftover: bound
 * to this adapter's permanent address, or bound to an address no present adapter
 * has (the randomized bindings that produced the duplicates in the first place).
 * A profile bound to another present adapter — or claimed by another adapter's
 * persisted identity — is always left alone, so a multi-radio device cannot lose
 * its second hotspot to the first one's cleanup.
 */
export async function pruneDuplicateHotspotConns(
	macAddress: MacAddress,
	keepUuid: ConnectionUUID,
	deps: HotspotProfileDeps = defaultHotspotProfileDeps,
): Promise<ConnectionUUID[]> {
	const rows = await listWirelessConns("uuid,type,name", deps);
	if (!rows) return [];

	const inUse = collectConnsInUse();
	const reserved = collectConnsReservedByOtherAdapters(macAddress);
	const presentAdapters = new Set(Object.keys(getWifiInterfacesByMacAddress()));
	const removed: ConnectionUUID[] = [];

	for (const [uuid, type, name] of rows) {
		if (!uuid || type !== "802-11-wireless" || uuid === keepUuid) continue;
		if (!name || !GENERATED_HOTSPOT_ID_RE.test(name)) continue;
		if (inUse.has(uuid) || reserved.has(uuid)) continue;

		const profile = await readApProfile(uuid, deps);
		if (!profile) continue;
		if (
			profile.macAddress !== macAddress &&
			presentAdapters.has(profile.macAddress)
		) {
			continue;
		}

		if (await deps.deleteConnection(uuid)) removed.push(uuid);
	}

	if (removed.length > 0) {
		logger.info(
			`Removed ${removed.length} superseded hotspot connection profile(s)`,
		);
	}
	return removed;
}
