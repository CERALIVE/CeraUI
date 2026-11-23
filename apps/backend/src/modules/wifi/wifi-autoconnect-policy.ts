import {
	getHotspotCredentialOwners,
	isHotspotPortCredentialCopy,
} from "./hotspot-credentials.ts";
import {
	getPersistedWifiAdapterMode,
	getPersistedWifiAdapterModes,
} from "./wifi-adapter-mode.ts";
import { reconcileWifiAdapterPolicies } from "./wifi-adapter-reconciler.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import {
	type RadioIdentity,
	type ReadRadioInventory,
	radioInventoryFor,
	wifiPhysicalPortWitnesses,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";

type HotspotAddressUniqueness =
	| "proven-unique"
	| "proven-non-unique"
	| "unknown";

function observedHotspotAddressCounts(
	macAddress: string,
	identities: Iterable<RadioIdentity>,
) {
	const phys = new Set(
		[...identities]
			.filter((identity) => identity.permanentMac === macAddress)
			.map((identity) => identity.lifetime?.phyPath),
	);
	const keys = new Set(
		[
			macAddress,
			...getHotspotCredentialOwners(),
			...Object.keys(getPersistedWifiAdapterModes()),
		].filter(
			(key) =>
				normalizeMacAddress(key.split("@")[0]) === macAddress &&
				!isHotspotPortCredentialCopy(key),
		),
	);
	return { phys: phys.size, owners: keys.size };
}

/** Restore may select a stricter port pin from positive observations alone. */
export function observedUniqueHotspotAddress(
	macAddress: string,
	identities: ReadonlyMap<string, RadioIdentity>,
): boolean {
	const { phys, owners } = observedHotspotAddressCounts(
		macAddress,
		identities.values(),
	);
	return phys === 1 && owners === 1;
}

export async function uniqueHotspotAddress(
	macAddress: string,
	readInventory: ReadRadioInventory,
): Promise<HotspotAddressUniqueness> {
	const inventory = await readInventory();
	if (inventory.kind === "unknown") return "unknown";
	const identities = wifiPhysicalPortWitnesses(inventory.rows);
	const { phys, owners } = observedHotspotAddressCounts(macAddress, identities);
	if (phys > 1) return "proven-non-unique";
	if (phys === 0 || identities.some((row) => !row.permanentMac))
		return "unknown";
	return owners === 1 ? "proven-unique" : "proven-non-unique";
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

type HotspotAutoconnectPolicy = {
	readonly fields: Record<string, string>;
	readonly current: (() => boolean) | undefined;
};

export async function hotspotAutoconnectPolicy(
	macAddress: string,
	binding: Readonly<Record<string, string>>,
): Promise<HotspotAutoconnectPolicy | undefined> {
	const intent = getPersistedWifiAdapterMode(macAddress);
	const physicalMac = normalizeMacAddress(macAddress.split("@")[0]);
	const inventory =
		(intent === "hotspot" || intent === "hybrid") &&
		physicalMac &&
		binding["802-11-wireless.mac-address"] === physicalMac &&
		binding["match.path"]
			? radioInventoryFor()
			: undefined;
	const uniqueness =
		inventory && physicalMac
			? await uniqueHotspotAddress(physicalMac, inventory)
			: "ineligible";
	// The binding was installed with autoconnect off. An unknown inventory
	// does not authorize another profile write.
	if (uniqueness === "unknown") return undefined;
	return {
		fields: {
			"connection.autoconnect": uniqueness === "proven-unique" ? "yes" : "no",
			"connection.autoconnect-priority": "999",
		},
		current: inventory?.current,
	};
}

export function quiesceHotspotAutoconnect(
	identities: ReadonlyMap<string, RadioIdentity>,
	activeConnections: Map<string | undefined, string | null>,
	readInventory = radioInventoryFor(identities),
): Promise<boolean> {
	return reconcileWifiAdapterPolicies({
		identities,
		active: activeConnections,
		readInventory,
	});
}
