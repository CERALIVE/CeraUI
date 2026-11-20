/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { ID_RE } from "../../helpers/run.ts";
import {
	nmConnGetFields,
	nmConnsGet,
	nmcliParseSep,
	nmDeviceProp,
} from "../network/network-manager.ts";
import { getHotspotCredentialOwners } from "./hotspot-credentials.ts";
import { wifiAdapterLockKey } from "./wifi-adapter-lock.ts";
import {
	releaseCreatedConcurrentApInterface,
	revalidateCreatedConcurrentApInterface,
} from "./wifi-concurrent-interface-creation.ts";
import {
	idleTarget,
	setConcurrentAutoconnect,
} from "./wifi-concurrent-interface-io.ts";
import {
	currentTarget,
	selectedTargets,
	targetRecords,
} from "./wifi-hybrid-target-record.ts";
import { wifiRadioIdentity } from "./wifi-radio-identity.ts";

export async function connectionsPermitAdoption(
	parentIfname: string,
	ifname: string,
): Promise<boolean> {
	const parent = wifiRadioIdentity.state.rows.get(parentIfname);
	if (!parent) return false;
	const owner = wifiAdapterLockKey(parent.key);
	const rows = await nmConnsGet("uuid,type");
	if (!rows) return false;
	for (const row of rows) {
		if (!row.trim()) continue;
		const [uuid, type, extra] = nmcliParseSep(row);
		if (!uuid || !type || extra !== undefined) return false;
		if (type !== "802-11-wireless") continue;
		const binding = await nmConnGetFields(uuid, [
			"connection.interface-name",
			"match.interface-name",
		] as const);
		if (binding?.length !== 2) return false;
		if (binding[1] && !ID_RE.test(binding[1])) return false;
		if (binding[0] !== ifname && binding[1] !== ifname) continue;
		const owners = getHotspotCredentialOwners(uuid);
		if (owners.length !== 1 || owners[0] !== owner) return false;
	}
	return true;
}

export async function revalidateConcurrentApInterface(target: {
	readonly ifname: string;
}): Promise<boolean> {
	const record = targetRecords.get(target);
	if (!record) return revalidateCreatedConcurrentApInterface(target);
	return (
		(await currentTarget(target.ifname, record)) &&
		(await idleTarget(target.ifname)) &&
		(await connectionsPermitAdoption(record.parentIfname, target.ifname))
	);
}

/** Deleting a created leg retires the selection bound to that object, so its name is again never-selected. */
export async function releaseCreatedHybridTarget(target: {
	ifname: string;
	created: boolean;
}): Promise<void> {
	const bound = targetRecords.get(target)?.wireless;
	if (!(await releaseCreatedConcurrentApInterface(target)) || !bound) return;
	// Autoconnect release may have replaced the record object; the deleted object's identity is what binds it.
	const stored = selectedTargets.get(target.ifname)?.record?.wireless;
	if (stored?.wdev === bound.wdev && stored.ifindex === bound.ifindex)
		selectedTargets.delete(target.ifname);
}

export async function releaseConcurrentApInterface(
	ifname: string,
): Promise<void> {
	const stored = selectedTargets.get(ifname);
	const record = stored?.record;
	if (!stored || !record || record.priorAutoconnect === undefined) return;
	try {
		if (!(await currentTarget(ifname, record)) || !(await idleTarget(ifname)))
			return;
		const current = (await nmDeviceProp(ifname, "GENERAL.AUTOCONNECT"))?.[0];
		const { priorAutoconnect: _prior, ...released } = record;
		if (current !== "no") {
			// A readable value other than ours is an external change: retire the claim, never overwrite it.
			// shortcut: an external A->B->A autoconnect cycle between our reads is unobservable (nmcli monitor reports only device/connection state); retire on property events if a device-property feed is ever consumed.
			if (current !== undefined)
				selectedTargets.set(ifname, { ...stored, record: released });
			return;
		}
		if (
			!(await setConcurrentAutoconnect(ifname, record.priorAutoconnect, () =>
				currentTarget(ifname, record),
			))
		)
			return;
		selectedTargets.set(ifname, { ...stored, record: released });
	} catch {
		return;
	}
}
