import { nmConnGetFields, nmConnsGet } from "../network/network-manager.ts";

const POLICY_FIELDS = [
	"802-11-wireless.mode",
	"connection.autoconnect",
	"connection.interface-name",
	"802-11-wireless.mac-address",
	"match.path",
] as const;

export type HotspotProfileObservation =
	| { readonly kind: "absent" }
	| { readonly kind: "unreadable" }
	| {
			readonly kind: "read";
			readonly mode: string;
			readonly autoconnect: string;
			readonly ifname: string;
			readonly mac: string;
			readonly path: string;
	  };

/** Detail failure alone never proves deletion or grants AP teardown authority. */
export async function observeHotspotProfile(
	uuid: string,
): Promise<HotspotProfileObservation> {
	const fields = await nmConnGetFields(uuid, POLICY_FIELDS);
	if (fields?.[0])
		return {
			kind: "read",
			mode: fields[0],
			autoconnect: fields[1],
			ifname: fields[2],
			mac: fields[3],
			path: fields[4],
		};
	const inventory = await nmConnsGet("uuid");
	return inventory && !inventory.includes(uuid)
		? { kind: "absent" }
		: { kind: "unreadable" };
}
