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
	getAllHotspotCredentials,
	getHotspotCredentials,
	type HotspotCredentials,
	rememberHotspotCredentials,
} from "./hotspot-credentials.ts";
import { channelFromNM } from "./wifi-channels.ts";
import { concurrentApIfname } from "./wifi-concurrent-interface.ts";
import {
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
} from "./wifi-connections.ts";
import { HOTSPOT_SECURITY, securityFromNM } from "./wifi-hotspot-security.ts";
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
		"connection.interface-name",
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
	const concurrentProfile =
		wifiInterface.supportsApStaConcurrency === true &&
		fields[11] === concurrentApIfname(wifiInterface.ifname);
	if (!concurrentProfile && fields[12].toLowerCase() !== macAddress) {
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

	// The profile itself is the truth about which security mode is in force, so
	// it is ADOPTED here rather than assumed from memory — the same rule the
	// channel above follows. A key-mgmt this build does not manage adopts
	// nothing and falls through to the modification warning.
	const observedSecurity = securityFromNM(fields[6]);
	if (observedSecurity !== undefined) {
		wifiInterface.hotspot.security = observedSecurity;
	}

	if (
		fields[5] !== "no" ||
		observedSecurity === undefined ||
		fields[7] !== "ccmp" ||
		fields[8] !== "ccmp" ||
		fields[9] !== "rsn" ||
		fields[10] !== HOTSPOT_SECURITY[observedSecurity].nmPmfObserved
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

		const concurrentProfile =
			wifiInterface?.supportsApStaConcurrency === true &&
			connIfName === concurrentApIfname(wifiInterface.ifname);
		if (
			!wifiInterface ||
			!canHotspot(wifiInterface) ||
			(wifiInterface.hotspot.conn !== uuid &&
				wifiInterface.ifname !== connIfName &&
				!concurrentProfile)
		) {
			continue;
		}

		// If we can match the connection against a certain interface
		if (!wifiInterface.hotspot.conn) {
			if (concurrentProfile) {
				wifiInterface.hotspot.conn = uuid;
				return macAddress;
			}
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

/**
 * The UUIDs cleanup is allowed to consider: every profile some adapter's
 * persisted identity has POSITIVELY claimed — as its current `conn` or in its
 * bounded `previousConns` history — minus every adapter's CURRENT profile.
 *
 * Absence is deliberately not part of this: a profile no persisted identity
 * names is simply unknown, and an unknown profile always survives. The retired
 * rule deleted any generated-name AP profile "bound to an address no present
 * adapter owns", which is exactly what a temporarily-unplugged adapter's own
 * hotspot looks like — so a cleanup could destroy the SSID and password an
 * operator's phone already knew.
 */
export function collectSupersededHotspotConns(
	identities: readonly HotspotCredentials[],
): Set<ConnectionUUID> {
	const owned = new Set<ConnectionUUID>();
	const current = new Set<ConnectionUUID>();

	for (const identity of identities) {
		if (identity.conn) {
			owned.add(identity.conn);
			current.add(identity.conn);
		}
		for (const uuid of identity.previousConns ?? []) owned.add(uuid);
	}

	for (const uuid of current) owned.delete(uuid);
	return owned;
}

/**
 * Delete superseded hotspot profiles so exactly one survives per adapter. Best
 * effort — a failure here never fails a hotspot start, and it is never promoted
 * to a blocking step (`wifi-hotspot-activation.ts` fires it and forgets it).
 *
 * A profile is removed ONLY when it carries ownership evidence
 * ({@link collectSupersededHotspotConns}), no adapter is currently using it, and
 * it is still a `nmcli`-generated AP profile. The generated-id name match is a
 * narrowing filter, NEVER evidence by itself — an operator who ran
 * `nmcli device wifi hotspot` gets the same name and the same `CERALIVE_`-shaped
 * SSID, and their profile is not ours to delete.
 */
export async function pruneDuplicateHotspotConns(
	macAddress: MacAddress,
	keepUuid: ConnectionUUID,
	deps: HotspotProfileDeps = defaultHotspotProfileDeps,
): Promise<ConnectionUUID[]> {
	const deletable = collectSupersededHotspotConns(getAllHotspotCredentials());
	deletable.delete(keepUuid);
	for (const uuid of collectConnsInUse()) deletable.delete(uuid);
	if (deletable.size === 0) return [];

	const rows = await listWirelessConns("uuid,type,name", deps);
	if (!rows) return [];

	const removed: ConnectionUUID[] = [];

	for (const [uuid, type, name] of rows) {
		if (!uuid || type !== "802-11-wireless") continue;
		if (!deletable.has(uuid)) continue;
		if (!name || !GENERATED_HOTSPOT_ID_RE.test(name)) continue;

		const profile = await readApProfile(uuid, deps);
		if (!profile) continue;

		if (await deps.deleteConnection(uuid)) removed.push(uuid);
	}

	if (removed.length > 0) {
		logger.info(
			`Removed ${removed.length} superseded hotspot connection profile(s) after starting ${macAddress}`,
		);
	}
	return removed;
}
