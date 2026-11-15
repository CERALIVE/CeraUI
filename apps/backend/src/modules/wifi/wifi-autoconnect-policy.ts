import { getHotspotCredentialOwners } from "./hotspot-credentials.ts";
import {
	getPersistedWifiAdapterMode,
	getPersistedWifiAdapterModes,
} from "./wifi-adapter-mode.ts";
import { reconcileWifiAdapterPolicies } from "./wifi-adapter-reconciler.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import {
	type RadioIdentity,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";

export function uniqueHotspotAddress(
	macAddress: string,
	identities: ReadonlyMap<string, RadioIdentity>,
): boolean {
	const phys = new Set(
		[...identities.values()]
			.filter((identity) => identity.permanentMac === macAddress)
			.map((identity) => identity.lifetime?.phyPath),
	);
	const keys = new Set(
		[
			macAddress,
			...getHotspotCredentialOwners(),
			...Object.keys(getPersistedWifiAdapterModes()),
		].filter((key) => normalizeMacAddress(key.split("@")[0]) === macAddress),
	);
	return phys.size === 1 && keys.size === 1;
}

/** A unique literal port from the same coherent sample as the MAC pin. */
export function hotspotDevicePath(
	macAddress: string,
	ifname: string,
): string | undefined {
	const identity = wifiRadioIdentity.state.rows.get(ifname);
	return identity?.classification === "verified" &&
		identity.permanentMac === macAddress
		? identity.devicePath
		: undefined;
}

export function hotspotAutoconnectFields(
	macAddress: string,
	binding: Readonly<Record<string, string>>,
): Record<string, string> {
	const intent = getPersistedWifiAdapterMode(macAddress);
	const physicalMac = normalizeMacAddress(macAddress.split("@")[0]);
	return {
		"connection.autoconnect":
			(intent === "hotspot" || intent === "hybrid") &&
			physicalMac &&
			binding["802-11-wireless.mac-address"] === physicalMac &&
			binding["match.path"] &&
			uniqueHotspotAddress(physicalMac, wifiRadioIdentity.state.rows)
				? "yes"
				: "no",
		"connection.autoconnect-priority": "999",
	};
}

export function quiesceHotspotAutoconnect(
	identities: ReadonlyMap<string, RadioIdentity>,
	activeConnections: Map<string | undefined, string | null>,
): Promise<boolean> {
	return reconcileWifiAdapterPolicies({
		identities,
		active: activeConnections,
	});
}
