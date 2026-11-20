import {
	getHotspotCredentialOwners,
	getHotspotCredentials,
	getPendingHotspotCreation,
} from "./hotspot-credentials.ts";
import { resolveWifiAdapterModeIntentKey } from "./wifi-adapter-mode-intent.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import { canHotspot } from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";
import {
	normalizeMacAddress,
	normalizeWifiAdapterKey,
	wifiAdapterKeyPort,
} from "./wifi-permanent-mac.ts";
import { wifiRadioIdentity } from "./wifi-radio-identity.ts";

const rowOwners = new WeakMap<WifiInterface, { owner: string; uuid: string }>();
const pendingOwners = new WeakMap<WifiInterface, string>();
const profileBindings = new Map<string, { owner: string; uuid: string }>();
const contradictedProfiles = new WeakMap<WifiInterface, Set<string>>();

/** A profile observation grants serialization authority, never activation authority. */
export function bindWifiAdapterOwner(
	ifname: string,
	owner: string,
	evidence: { readonly uuid: string; readonly pinsMatch: boolean },
): void {
	const { uuid, pinsMatch } = evidence;
	const rows = Object.values(getWifiInterfacesByMacAddress()).filter(
		(row) => row.ifname === ifname,
	);
	if (
		!pinsMatch &&
		rows.some((row) => contradictedProfiles.get(row)?.has(uuid))
	)
		return;
	profileBindings.set(ifname, { owner, uuid });
	for (const row of rows) contradictedProfiles.get(row)?.delete(uuid);
}

/** Positive NM pin contradictions revoke cached hints, never a held operation. */
export function revokeWifiAdapterOwner(
	ifname: string,
	owner: string,
	uuid: string,
): void {
	const binding = profileBindings.get(ifname);
	if (binding?.owner === owner && binding.uuid === uuid)
		profileBindings.delete(ifname);
	for (const row of Object.values(getWifiInterfacesByMacAddress())) {
		if (row.ifname !== ifname) continue;
		const remembered = rowOwners.get(row);
		if (remembered?.owner === owner && remembered.uuid === uuid)
			rowOwners.delete(row);
		const rejected = contradictedProfiles.get(row) ?? new Set<string>();
		rejected.add(uuid);
		contradictedProfiles.set(row, rejected);
	}
}

export function beginWifiAdapterOwnerObservation(): void {
	profileBindings.clear();
}

export function resolveWifiAdapterOwner(
	registryKey: string,
	row?: WifiInterface,
): string {
	const pending = row && pendingOwners.get(row);
	if (pending) return pending;
	if (wifiAdapterKeyPort(registryKey))
		return normalizeWifiAdapterKey(registryKey);
	if (row) {
		const identity = wifiRadioIdentity.state.rows.get(row.ifname);
		if (
			identity?.row === row &&
			identity.key === registryKey &&
			identity.classification === "verified" &&
			identity.devicePath
		) {
			const portOwner = `${registryKey}@${identity.devicePath}`;
			const saved = getHotspotCredentials(portOwner);
			if (
				saved?.conn ||
				saved?.previousConns?.length ||
				getPendingHotspotCreation(portOwner)
			)
				return portOwner;
		}
		const activeUuid =
			row.activeMode === "ap"
				? row.activeConn
				: row.concurrentHotspot?.activeConn;
		const uuid = activeUuid ?? (canHotspot(row) ? row.hotspot.conn : undefined);
		const rejected = contradictedProfiles.get(row);
		const contradicted =
			!activeUuid && uuid !== undefined && rejected?.has(uuid);
		const owners =
			uuid && !contradicted ? getHotspotCredentialOwners(uuid) : [];
		const binding = profileBindings.get(row.ifname);
		const remembered = rowOwners.get(row);
		let owner = owners.length === 1 ? owners[0] : undefined;
		let ownedUuid = uuid;
		if (owners.length === 0) {
			for (const candidate of [binding, remembered]) {
				if (
					candidate &&
					!rejected?.has(candidate.uuid) &&
					(!uuid || uuid === candidate.uuid) &&
					getHotspotCredentialOwners(candidate.uuid).includes(candidate.owner)
				) {
					owner = candidate.owner;
					ownedUuid = candidate.uuid;
					break;
				}
			}
		}
		if (
			owner &&
			(!normalizeMacAddress(registryKey) ||
				normalizeMacAddress(owner.split("@")[0]) === registryKey)
		) {
			if (ownedUuid) rowOwners.set(row, { owner, uuid: ownedUuid });
			return owner;
		}
		// D12 is the sole-radio exception; observed UUID ownership takes precedence.
		if (
			owners.length === 0 &&
			!normalizeMacAddress(registryKey) &&
			!rejected?.size
		) {
			const intent = resolveWifiAdapterModeIntentKey(
				registryKey,
				undefined,
				Object.values(getWifiInterfacesByMacAddress()).filter(canHotspot)
					.length,
			);
			if (intent) return intent;
		}
	}
	return normalizeWifiAdapterKey(registryKey);
}

/** Intent changes cannot move an admitted operation into another lock domain. */
export function retainWifiAdapterOwners(
	owner: string,
	interfaces: Readonly<Record<string, WifiInterface>>,
): () => void {
	const rows = Object.entries(interfaces)
		.filter(([key, row]) => resolveWifiAdapterOwner(key, row) === owner)
		.map(([, row]) => row);
	for (const row of rows) pendingOwners.set(row, owner);
	return () => {
		for (const row of rows) pendingOwners.delete(row);
	};
}
