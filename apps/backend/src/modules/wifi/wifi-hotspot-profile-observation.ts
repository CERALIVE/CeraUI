import { nmConnGetFields, nmConnsGet } from "../network/network-manager.ts";
import {
	type NmProfileReadTrace,
	warnNmProfileRetirement,
} from "../network/network-manager-profile-diagnostics.ts";
import {
	readNmProfileInstance,
	sameNmProfileResource,
} from "../network/network-manager-profile-instance.ts";
import {
	clearHotspotProfileCreation,
	getHotspotCredentialOwners,
	getPendingHotspotCreation,
	getPendingHotspotCreationInstance,
	recordHotspotProfileCreation,
} from "./hotspot-credentials.ts";
import { retryWifiAdapterReconcile } from "./wifi-adapter-reconcile-retry.ts";

export function retireHotspotProfileAuthority(
	owner: string,
	uuid: string,
): void {
	clearHotspotProfileCreation(owner, uuid);
	retryWifiAdapterReconcile(
		owner,
		`creation authority lost for ${uuid}`,
		"authority",
	);
}

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
	| { readonly kind: "replaced" }
	| {
			readonly kind: "read";
			readonly mode: string;
			readonly autoconnect: string;
			readonly ifname: string;
			readonly mac: string;
			readonly path: string;
			readonly firstStart: boolean;
	  };

/** Detail failure alone never proves deletion or grants AP teardown authority. */
export async function observeHotspotProfile(
	uuid: string,
): Promise<HotspotProfileObservation> {
	const creators = getHotspotCredentialOwners(uuid).filter(
		(owner) => getPendingHotspotCreation(owner) === uuid,
	);
	if (creators.length) {
		const trace: NmProfileReadTrace = {};
		const instance = await readNmProfileInstance(uuid, undefined, trace);
		if (instance === undefined) {
			const first = creators[0];
			const expected =
				first === undefined
					? undefined
					: getPendingHotspotCreationInstance(first);
			for (const owner of creators) retireHotspotProfileAuthority(owner, uuid);
			await warnNmProfileRetirement(
				"observation-unreadable",
				expected,
				instance,
				trace,
			);
			return { kind: "unreadable" };
		}
		let replaced = false;
		for (const owner of creators) {
			const expected = getPendingHotspotCreationInstance(owner);
			if (!sameNmProfileResource(expected, instance)) {
				if (instance === null) clearHotspotProfileCreation(owner, uuid);
				else retireHotspotProfileAuthority(owner, uuid);
				if (!replaced)
					await warnNmProfileRetirement(
						"observation-mismatch",
						expected,
						instance,
						trace,
					);
				replaced = true;
			} else if (
				instance &&
				expected?.runId !== instance.runId &&
				!recordHotspotProfileCreation(owner, uuid, instance)
			) {
				return { kind: "unreadable" };
			}
		}
		if (replaced) return { kind: instance === null ? "absent" : "replaced" };
	}
	const fields = await nmConnGetFields(uuid, POLICY_FIELDS);
	if (fields?.[0])
		return {
			kind: "read",
			mode: fields[0],
			autoconnect: fields[1],
			ifname: fields[2],
			mac: fields[3],
			path: fields[4],
			firstStart: creators.length > 0,
		};
	const inventory = await nmConnsGet("uuid");
	return inventory && !inventory.includes(uuid)
		? { kind: "absent" }
		: { kind: "unreadable" };
}
