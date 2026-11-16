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
	nmConnsGet,
	nmcliParseSep,
} from "../network/network-manager.ts";
import {
	isNmWifiSecretAvailable,
	readVerifiedNmWifiSecret,
} from "../network/network-manager-secret.ts";
import {
	canUseHotspotConnection,
	clearHotspotProfileCreation,
	getAllHotspotCredentials,
	getHotspotCredentialOwners,
	getHotspotCredentials,
	getPendingHotspotCreation,
	type HotspotCredentials,
	rememberHotspotCredentials,
} from "./hotspot-credentials.ts";
import {
	ownsWifiAdapterLock,
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import { resolveWifiAdapterOwner } from "./wifi-adapter-owner.ts";
import { admitWifiRequest } from "./wifi-binding.ts";
import { channelFromNM } from "./wifi-channels.ts";
import { isConcurrentApIfname } from "./wifi-concurrent-interface.ts";
import {
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
} from "./wifi-connections.ts";
import {
	recordHotspotProfileDeletion,
	trackHotspotProfileRead,
	wasHotspotConnDeletedSince,
} from "./wifi-hotspot-discovery-fence.ts";
import { runHotspotProfileOperation } from "./wifi-hotspot-profile-operation.ts";
import { HOTSPOT_SECURITY, securityFromNM } from "./wifi-hotspot-security.ts";
import {
	canHotspot,
	type ExistingHotspotConn,
	type WifiHotspot,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";

const hotspotProfilePins = new WeakMap<
	WifiHotspot,
	{ readonly uuid: string; readonly macAddress: string }
>();
const deletingHotspotConns = new Set<ConnectionUUID>();

export function rememberHotspotProfilePin(
	hotspot: WifiHotspot,
	uuid: string,
	macAddress: string = "",
): void {
	hotspotProfilePins.set(hotspot, { uuid, macAddress });
}

export function getHotspotProfilePin(
	hotspot: WifiHotspot,
	uuid: string | undefined,
): string | undefined {
	const pin = hotspotProfilePins.get(hotspot);
	return pin?.uuid === uuid ? pin?.macAddress : undefined;
}

/** Keep pin evidence outside the legacy registry and wire projections. */
export function hotspotOwnershipGuard(
	macAddress: string,
	iface: WifiInterfaceWithHotspot,
	initialConn?: string,
): (conn?: string, profileMac?: string) => boolean {
	const hotspot = iface.hotspot;
	const initialPin = getHotspotProfilePin(hotspot, initialConn);
	return (
		conn = initialConn,
		profileMac = conn === initialConn ? initialPin : undefined,
	) =>
		iface.hotspot === hotspot &&
		canAdoptHotspotProfile(
			macAddress,
			hotspot.conn,
			getHotspotProfilePin(hotspot, hotspot.conn) ?? "",
		) &&
		canAdoptHotspotProfile(
			macAddress,
			conn,
			profileMac ?? getHotspotProfilePin(hotspot, conn) ?? "",
		);
}

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
	if (deletingHotspotConns.has(uuid)) return false;
	if (options.active) return true;
	return !stored?.conn || stored.conn === uuid;
}

async function applyHotspotCredentialReadback(
	registryKey: string,
	iface: WifiInterfaceWithHotspot,
	uuid: string,
	observed: string | undefined,
	settings: Readonly<Record<string, string>>,
	apply: (password: string | undefined) => void,
	owner = registryKey,
): Promise<void> {
	const hotspot = iface.hotspot;
	const initial = {
		conn: hotspot.conn,
		name: hotspot.name,
		channel: hotspot.channel,
		security: hotspot.security,
	};
	const physicalMac = normalizeMacAddress(owner.split("@")[0]);
	const binding =
		settings["802-11-wireless.mac-address"] ??
		getHotspotProfilePin(hotspot, uuid) ??
		physicalMac ??
		"";
	const active = () =>
		(iface.activeConn === uuid && iface.activeMode === "ap") ||
		iface.concurrentHotspot?.activeConn === uuid;
	const stored = () => (physicalMac ? getHotspotCredentials(owner) : undefined);
	const knownPassword = (credential: HotspotCredentials | undefined) => {
		if (credential?.conn === uuid) return credential.password;
		if (credential?.conn) return undefined;
		const matched =
			hotspot.conn === uuid &&
			(getHotspotProfilePin(hotspot, uuid) === binding || active());
		if (
			credential &&
			credential.ssid === settings["802-11-wireless.ssid"] &&
			(getPendingHotspotCreation(owner) === uuid || matched)
		)
			return credential.password;
		return matched ? hotspot.password : undefined;
	};
	const before = stored();
	const known = knownPassword(before);
	const cachedPresent = Boolean(hotspot.password);
	const available = isNmWifiSecretAvailable(observed);
	const verifiedPassword =
		available && observed === known
			? known
			: available
				? await readVerifiedNmWifiSecret(uuid, {
						...settings,
						"802-11-wireless.mac-address": binding,
					})
				: undefined;
	const verified = verifiedPassword !== undefined;
	const current = stored();
	if (
		getWifiInterfaceByMacAddress(registryKey) !== iface ||
		iface.hotspot !== hotspot ||
		hotspot.conn !== initial.conn ||
		hotspot.name !== initial.name ||
		hotspot.channel !== initial.channel ||
		hotspot.security !== initial.security ||
		current?.conn !== before?.conn ||
		current?.ssid !== before?.ssid ||
		current?.channel !== before?.channel ||
		!(physicalMac ? canAdoptHotspotProfile(owner, uuid, binding) : active())
	)
		return;
	const knownNow = knownPassword(current);
	const ownWriteWon = knownNow !== known;
	const password = ownWriteWon
		? knownNow
		: verified
			? verifiedPassword
			: knownNow;
	const digest = (value: string | undefined) =>
		value
			? new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 12)
			: null;
	apply(password);
	const committed = stored();
	if (committed?.conn === uuid && password && password !== committed.password)
		rememberHotspotCredentials(owner, { ...committed, password });
	logger.warn(
		verified && !ownWriteWon && password !== known
			? "Hotspot credential readback updated"
			: "Hotspot credential readback preserved",
		{
			storedPresent: Boolean(current?.password),
			cachedPresent,
			observedPresent: Boolean(observed),
			observedHidden: observed === "<hidden>",
			verifiedRead: verified && password === observed,
			ownWriteWon,
			sameProfile: Boolean(knownNow),
			source: Object.hasOwn(settings, "802-11-wireless.mac-address")
				? "profile-discovery"
				: "active-unresolved",
			storedDigest: digest(
				current?.conn === uuid ? current.password : undefined,
			),
			observedDigest: digest(available ? observed : undefined),
			credentialDigest: digest(password),
		},
	);
}

export async function handleHotspotConn(
	macAddress_: string | undefined,
	uuid: string,
	options: HotspotAdoptionOptions = {},
): Promise<void> {
	return observeHotspotConn(macAddress_, uuid, options);
}

/** Lock acquisition may restart the observation without re-entering the public sweep hook. */
async function observeHotspotConn(
	macAddress_: string | undefined,
	uuid: string,
	options: HotspotAdoptionOptions,
): Promise<void> {
	if (
		macAddress_ !== undefined &&
		(!normalizeMacAddress(macAddress_) ||
			getWifiInterfaceByMacAddress(macAddress_)?.degradedReason ===
				"permanent-mac-unresolved")
	) {
		const row = getWifiInterfaceByMacAddress(macAddress_);
		if (
			!options.active ||
			!row ||
			!canHotspot(row) ||
			!(
				(row.activeConn === uuid && row.activeMode === "ap") ||
				row.concurrentHotspot?.activeConn === uuid
			)
		)
			return;
		if (row.hotspot.conn !== uuid) {
			delete row.hotspot.name;
			delete row.hotspot.password;
			delete row.hotspot.channel;
			delete row.hotspot.security;
		}
		row.hotspot.conn = uuid;
		const fields = await nmConnGetFields(uuid, [
			"802-11-wireless.mode",
			"802-11-wireless.ssid",
			"802-11-wireless-security.psk",
			"802-11-wireless.band",
			"802-11-wireless.channel",
			"802-11-wireless-security.key-mgmt",
			"802-11-wireless.mac-address",
		] as const);
		if (fields?.[0] && fields[0] !== "ap" && row.hotspot.conn === uuid) {
			delete row.hotspot.conn;
			delete row.hotspot.name;
			delete row.hotspot.password;
			delete row.hotspot.channel;
			delete row.hotspot.security;
			return;
		}
		if (
			fields?.[0] !== "ap" ||
			row.hotspot.conn !== uuid ||
			(row.activeConn !== uuid && row.concurrentHotspot?.activeConn !== uuid)
		)
			return;
		await applyHotspotCredentialReadback(
			macAddress_,
			row,
			uuid,
			fields[2],
			{
				"802-11-wireless.ssid": fields[1],
				"802-11-wireless.band": fields[3],
				"802-11-wireless.channel": fields[4],
				"802-11-wireless-security.key-mgmt": fields[5],
				"802-11-wireless.mac-address": fields[6],
			},
			(password) => {
				row.hotspot.conn = uuid;
				row.hotspot.name = fields[1];
				if (password === undefined) delete row.hotspot.password;
				else row.hotspot.password = password;
				row.hotspot.channel = channelFromNM(fields[3], fields[4]);
				const security = securityFromNM(fields[5]);
				if (security !== undefined) row.hotspot.security = security;
			},
		);
		return;
	}
	const suppliedRow =
		macAddress_ === undefined
			? undefined
			: getWifiInterfaceByMacAddress(macAddress_);
	if (macAddress_ && suppliedRow && canHotspot(suppliedRow)) {
		const suppliedKey = wifiAdapterLockKey(macAddress_);
		if (!ownsWifiAdapterLock(suppliedKey)) {
			const locked = await withWifiAdapterLock(suppliedKey, () =>
				admitWifiRequest(
					suppliedRow,
					() => observeHotspotConn(macAddress_, uuid, options),
					() => undefined,
				),
			);
			if (locked.success) return;
			// A busy owner still needs read-side rejection evidence; defer only its writes below.
		}
	}
	if (deletingHotspotConns.has(uuid)) return;
	using read = trackHotspotProfileRead();
	const epoch = read.epoch;
	const fields = await nmConnGetFields(uuid, [
		"connection.autoconnect-priority",
		"802-11-wireless.ssid",
		"802-11-wireless-security.psk",
		"802-11-wireless.band",
		"802-11-wireless.channel",
		"802-11-wireless.hidden",
		"802-11-wireless-security.key-mgmt",
		"802-11-wireless-security.pairwise",
		"802-11-wireless-security.group",
		"802-11-wireless-security.proto",
		"802-11-wireless-security.pmf",
		"connection.interface-name",
		"802-11-wireless.mac-address",
	] as const);
	if (wasHotspotConnDeletedSince(uuid, epoch)) return;
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
	const macAddress =
		pinned ||
		(await findMacAddressForConnection(
			uuid,
			fields?.[12] ?? macAddress_ ?? "",
		));
	if (wasHotspotConnDeletedSince(uuid, epoch)) return;
	if (!macAddress) {
		return;
	}
	const owner = resolveWifiAdapterOwner(
		macAddress,
		getWifiInterfaceByMacAddress(macAddress),
	);
	if (!canAdoptHotspotProfile(owner, uuid, fields?.[12] ?? "")) {
		return clearRejectedHotspotConn(macAddress, uuid);
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
	const lockKey = wifiAdapterLockKey(macAddress);
	if (!ownsWifiAdapterLock(lockKey)) {
		// A busy transaction owns normalization; the next discovery retries it.
		await withWifiAdapterLock(lockKey, () =>
			admitWifiRequest(
				wifiInterface,
				() => observeHotspotConn(macAddress_, uuid, options),
				() => undefined,
			),
		);
		return;
	}

	if (
		// Interface already has a different hotspot connection
		wifiInterface.hotspot.conn &&
		wifiInterface.hotspot.conn !== uuid
	) {
		if (!pinned) {
			if (
				!(
					await runHotspotProfileOperation({
						uuid,
						kind: "modify",
						fields: { "connection.autoconnect": "no" },
						run: (fields) => nmConnSetFields(uuid, fields),
					})
				).checked
			)
				return;
			if (!canAdoptHotspotProfile(owner, uuid, fields?.[12] ?? ""))
				clearRejectedHotspotConn(macAddress, uuid);
			return;
		}
		logger.warn(
			"Can not update hotspot connection, interface already has an active connection",
		);
		return;
	}

	const stored = getHotspotCredentials(owner);
	if (!shouldAdoptHotspotConn(uuid, stored, options)) {
		// Another profile is this adapter's persisted identity — keep this
		// duplicate from auto-starting and from claiming the adapter.
		if (
			!(
				await runHotspotProfileOperation({
					uuid,
					kind: "modify",
					fields: { "connection.autoconnect": "no" },
					run: (fields) => nmConnSetFields(uuid, fields),
				})
			).checked
		)
			return;
		if (!canAdoptHotspotProfile(owner, uuid, fields?.[12] ?? "")) {
			clearRejectedHotspotConn(macAddress, uuid);
		}
		return;
	}
	const binding = fields
		? ([fields[11], fields[12]] as const)
		: !pinned
			? await nmConnGetFields(uuid, [
					"connection.interface-name",
					"802-11-wireless.mac-address",
				] as const)
			: undefined;
	if (!binding || wasHotspotConnDeletedSince(uuid, epoch)) return;
	const concurrentProfile =
		binding[0] === wifiInterface.concurrentHotspot?.ifname ||
		(stored?.conn === uuid && isConcurrentApIfname(binding[0]));
	const ownsProfile = hotspotOwnershipGuard(owner, wifiInterface, uuid);
	let profileMac = binding[1];
	if (!ownsProfile(uuid, profileMac))
		return clearRejectedHotspotConn(
			macAddress,
			wifiInterface.hotspot.conn ?? uuid,
		);
	if (!concurrentProfile && profileMac.toLowerCase() !== macAddress) {
		const repaired = await runHotspotProfileOperation({
			uuid,
			kind: "modify",
			fields: {
				"connection.interface-name": "",
				"802-11-wireless.mac-address": macAddress,
			},
			run: (fields) => nmConnSetFields(uuid, fields),
		});
		if (!repaired.checked || (!pinned && !repaired.success)) return;
		if (repaired.success) profileMac = macAddress;
	}
	if (wasHotspotConnDeletedSince(uuid, epoch) || !ownsProfile(uuid, profileMac))
		return clearRejectedHotspotConn(
			macAddress,
			wifiInterface.hotspot.conn ?? uuid,
		);
	if (!pinned) {
		rememberHotspotProfilePin(wifiInterface.hotspot, uuid, profileMac);
		wifiInterface.hotspot.conn = uuid;
	}
	if (fields === undefined) return;

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
	/* If the connection doesn't have maximum priority, update it
     This is required to ensure the hotspot is started even if the Wifi
     networks for some matching client connections are available
  */
	if (fields[0] !== "999") {
		if (
			!(
				await runHotspotProfileOperation({
					uuid,
					kind: "modify",
					fields: { "connection.autoconnect-priority": "999" },
					run: (fields) => nmConnSetFields(uuid, fields),
				})
			).checked
		)
			return;
		if (wasHotspotConnDeletedSince(uuid, epoch)) return;
	}

	if (wasHotspotConnDeletedSince(uuid, epoch)) return;
	if (!ownsProfile(uuid, profileMac)) {
		return clearRejectedHotspotConn(
			macAddress,
			wifiInterface.hotspot.conn ?? uuid,
		);
	}
	rememberHotspotProfilePin(wifiInterface.hotspot, uuid, profileMac);
	// The profile itself is the truth about which security mode is in force, so
	// it is ADOPTED here rather than assumed from memory — the same rule the
	// channel above follows. A key-mgmt this build does not manage adopts
	// nothing and falls through to the modification warning.
	const observedSecurity = securityFromNM(fields[6]);
	await applyHotspotCredentialReadback(
		macAddress,
		wifiInterface,
		uuid,
		fields[2],
		{
			"802-11-wireless.ssid": fields[1],
			"802-11-wireless.band": fields[3],
			"802-11-wireless.channel": fields[4],
			"802-11-wireless-security.key-mgmt": fields[6],
			"802-11-wireless.mac-address": profileMac,
		},
		(password) => {
			wifiInterface.hotspot.conn = uuid;
			wifiInterface.hotspot.name = fields[1];
			if (password === undefined) delete wifiInterface.hotspot.password;
			else wifiInterface.hotspot.password = password;
			wifiInterface.hotspot.channel = concurrentProfile
				? (stored?.channel ??
					wifiInterface.hotspot.channel ??
					channelFromNM(fields[3], fields[4]))
				: channelFromNM(fields[3], fields[4]);
			if (password !== undefined)
				rememberHotspotCredentials(owner, {
					ssid: fields[1],
					password,
					conn: uuid,
					channel: wifiInterface.hotspot.channel,
				});
			if (observedSecurity !== undefined)
				wifiInterface.hotspot.security = observedSecurity;
			if (
				fields[5] !== "no" ||
				observedSecurity === undefined ||
				fields[7] !== "ccmp" ||
				fields[8] !== "ccmp" ||
				fields[9] !== "rsn" ||
				fields[10] !== HOTSPOT_SECURITY[observedSecurity].nmPmfObserved
			)
				wifiInterface.hotspot.warnings.modified = true;
		},
		owner,
	);
}

function clearRejectedHotspotConn(macAddress: string, uuid: string): void {
	const iface = getWifiInterfaceByMacAddress(macAddress);
	if (!iface || !canHotspot(iface) || iface.hotspot.conn !== uuid) return;
	const hotspot = { ...iface.hotspot };
	delete hotspot.conn;
	delete hotspot.name;
	delete hotspot.password;
	// Replacing the rejected cache also invalidates operations waiting on it.
	iface.hotspot = hotspot;
}

export function canAdoptHotspotProfile(
	macAddress: string,
	uuid: string | undefined,
	profileMac: string,
): boolean {
	const physicalMac = normalizeMacAddress(macAddress.split("@")[0]);
	if (!physicalMac) return false;
	const pin = profileMac.toLowerCase();
	return (
		(!uuid || !deletingHotspotConns.has(uuid)) &&
		canUseHotspotConnection(macAddress, uuid) &&
		(pin === physicalMac ||
			(!getWifiInterfaceByMacAddress(pin) && !getHotspotCredentials(pin)))
	);
}

async function findMacAddressForConnection(uuid: string, profileMac: string) {
	using read = trackHotspotProfileRead();
	const epoch = read.epoch;
	// Check if the connection is in use for any wifi interface
	const connIfName = (
		await nmConnGetFields(uuid, ["connection.interface-name"] as const)
	)?.[0];
	if (wasHotspotConnDeletedSince(uuid, epoch)) return undefined;

	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];

		const concurrentProfile =
			wifiInterface?.concurrentHotspot !== undefined &&
			connIfName === wifiInterface.concurrentHotspot.ifname;
		if (
			!wifiInterface ||
			!canHotspot(wifiInterface) ||
			!normalizeMacAddress(macAddress.split("@")[0]) ||
			wifiInterface.degradedReason === "permanent-mac-unresolved" ||
			(wifiInterface.hotspot.conn !== uuid &&
				wifiInterface.ifname !== connIfName &&
				!concurrentProfile)
		) {
			continue;
		}
		const owner = resolveWifiAdapterOwner(macAddress, wifiInterface);
		if (canAdoptHotspotProfile(owner, uuid, profileMac)) return macAddress;
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
	deleteConnection: async (uuid) =>
		(
			await runHotspotProfileOperation({
				uuid,
				kind: "delete",
				run: () => nmConnDelete(uuid),
			})
		).success,
};

async function readApProfile(
	uuid: ConnectionUUID,
	deps: HotspotProfileDeps,
): Promise<ApProfile | undefined> {
	if (deletingHotspotConns.has(uuid)) return undefined;
	using read = trackHotspotProfileRead();
	const epoch = read.epoch;
	const fields = await deps.getApProfileFields(uuid);
	if (wasHotspotConnDeletedSince(uuid, epoch)) return undefined;
	if (deletingHotspotConns.has(uuid)) return undefined;
	if (fields === undefined) return undefined;
	if (fields[0] !== "ap" || !fields[1]) return undefined;
	return {
		uuid,
		ssid: fields[1],
		password: isNmWifiSecretAvailable(fields[2]) ? fields[2] : "",
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
	const physicalMac = normalizeMacAddress(macAddress.split("@")[0]);
	using read = trackHotspotProfileRead();
	const epoch = read.epoch;
	if (stored?.conn) {
		const profile = await readApProfile(stored.conn, deps);
		if (
			profile &&
			!wasHotspotConnDeletedSince(profile.uuid, epoch) &&
			canAdoptHotspotProfile(macAddress, profile.uuid, profile.macAddress)
		) {
			return profile;
		}
	}

	const rows = await listWirelessConns("uuid,type", deps);
	if (!rows) return undefined;

	let ssidMatch: ApProfile | undefined;
	for (const [uuid, type] of rows) {
		if (!uuid || type !== "802-11-wireless") continue;
		if (uuid === stored?.conn || wasHotspotConnDeletedSince(uuid, epoch))
			continue;
		const profile = await readApProfile(uuid, deps);
		if (!profile || wasHotspotConnDeletedSince(uuid, epoch)) continue;
		if (!canAdoptHotspotProfile(macAddress, uuid, profile.macAddress)) continue;
		if (profile.macAddress === physicalMac) return profile;
		if (stored && profile.ssid === stored.ssid) ssidMatch ??= profile;
	}

	return ssidMatch &&
		!wasHotspotConnDeletedSince(ssidMatch.uuid, epoch) &&
		canAdoptHotspotProfile(macAddress, ssidMatch.uuid, ssidMatch.macAddress)
		? ssidMatch
		: undefined;
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
	for (const owner of getHotspotCredentialOwners()) {
		const pending = getPendingHotspotCreation(owner);
		if (pending) inUse.add(pending);
	}
	for (const wifiInterface of Object.values(getWifiInterfacesByMacAddress())) {
		if (!wifiInterface) continue;
		if (wifiInterface.conn) inUse.add(wifiInterface.conn);
		if (wifiInterface.activeConn) inUse.add(wifiInterface.activeConn);
		if (wifiInterface.concurrentHotspot?.activeConn) {
			inUse.add(wifiInterface.concurrentHotspot.activeConn);
		}
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

		if (deletingHotspotConns.has(uuid)) continue;
		// Reserve before the final recheck so discovery cannot adopt the profile
		// while nmcli deletion is pending. No await separates reservation/recheck.
		deletingHotspotConns.add(uuid);
		try {
			if (
				!collectSupersededHotspotConns(getAllHotspotCredentials()).has(uuid) ||
				collectConnsInUse().has(uuid)
			)
				continue;

			if (await deps.deleteConnection(uuid)) {
				recordHotspotProfileDeletion(uuid);
				for (const owner of getHotspotCredentialOwners(uuid))
					clearHotspotProfileCreation(owner, uuid);
				removed.push(uuid);
			}
		} finally {
			deletingHotspotConns.delete(uuid);
		}
	}

	if (removed.length > 0) {
		logger.info(
			`Removed ${removed.length} superseded hotspot connection profile(s) after starting ${macAddress}`,
		);
	}
	return removed;
}
