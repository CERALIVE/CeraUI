/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { nmDeviceProp } from "../network/network-manager.ts";
import {
	fittingApStaCombination,
	isQualifiedNmManagedHybrid,
} from "./wifi-ap-sta-capability.ts";
import {
	type ConcurrentApInterface,
	ensureConcurrentApInterface,
	releaseCreatedConcurrentApInterface,
	revalidateCreatedConcurrentApInterface,
} from "./wifi-concurrent-interface-creation.ts";
import {
	readConcurrentBootId as bootIdReader,
	idleTarget,
	runConcurrentInterface as interfaceRunner,
} from "./wifi-concurrent-interface-io.ts";
import {
	connectionsPermitAdoption,
	releaseConcurrentApInterface,
} from "./wifi-hybrid-target-policy.ts";
import {
	currentTarget,
	matchesConcurrentDiscoveryBoot,
	sameLifetime,
	selectedTargets,
	type TargetRecord,
	targetRecords,
} from "./wifi-hybrid-target-record.ts";
import {
	type CreatedInterface,
	concurrentApIfname,
	interfaceIdentity,
} from "./wifi-interface-creation.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { sampleRadio } from "./wifi-radio-read-budget.ts";

/** Select one coherent qualified leg. Observation never becomes creation ownership. */
export async function selectConcurrentApInterface(
	parentIfname: string,
	admitted: () => boolean = () => true,
	createMissing = false,
): Promise<ConcurrentApInterface | undefined> {
	if (!admitted() || !isQualifiedNmManagedHybrid(parentIfname))
		return undefined;
	const boot = (await bootIdReader())?.trim();
	const parent = await sampleRadio(
		parentIfname,
		radioIdentityReaders,
		undefined,
	);
	if (!boot || !matchesConcurrentDiscoveryBoot(boot) || !parent || !admitted())
		return undefined;
	const parentIdentity = wifiRadioIdentity.state.rows.get(parentIfname);
	if (
		!parentIdentity?.lifetime ||
		!sameLifetime(parent.lifetime, parentIdentity.lifetime) ||
		(!parent.macReadFailed &&
			parent.permanentMac !== parentIdentity.permanentMac)
	)
		return undefined;
	const ifname = concurrentApIfname(parentIfname);
	const existing = await sampleRadio(ifname, radioIdentityReaders, undefined);
	if (!existing && !createMissing) return undefined;
	if (
		existing &&
		(existing.lifetime.phyPath !== parent.lifetime.phyPath ||
			existing.lifetime.wiphy !== parent.lifetime.wiphy)
	)
		return undefined;
	const stored = selectedTargets.get(ifname);
	if (
		stored &&
		(stored.boot !== boot ||
			!existing ||
			!sameLifetime(stored.first, existing.lifetime))
	)
		return undefined;
	const previous = stored?.record;
	if (previous && !(await currentTarget(ifname, previous))) return undefined;
	const phy = `phy${parent.lifetime.wiphy}`;
	const dump = await interfaceRunner("iw", ["dev"]);
	const roles: Record<string, number> = { managed: 1, ap: 1, "p2p-device": 1 };
	let currentPhy: string | undefined;
	let name: string | undefined;
	let index: string | undefined;
	let wdev: string | undefined;
	let admittedWireless:
		| {
				readonly ifindex: string | undefined;
				readonly wdev: string | undefined;
		  }
		| undefined;
	let p2p = 0;
	let parentSeen = false;
	let targetSeen = false;
	for (const line of dump.split("\n")) {
		const header = /^\s*phy#(\d+)\s*$/.exec(line);
		if (header) {
			currentPhy = `phy${header[1]}`;
			name = undefined;
		}
		const named = /^\s*Interface\s+(\S+)/.exec(line);
		if (named) [name, index, wdev] = [named[1], undefined, undefined];
		index = /^\s*ifindex\s+(\d+)\s*$/.exec(line)?.[1] ?? index;
		wdev = /^\s*wdev\s+(0x[0-9a-f]+)\s*$/i.exec(line)?.[1] ?? wdev;
		if (/Unnamed\/non-netdev interface/.test(line)) name = undefined;
		const type = /^\s*type\s+(.+?)\s*$/.exec(line)?.[1]?.toLowerCase();
		if (!type || currentPhy !== phy) continue;
		if (type === "p2p-device") {
			if (
				++p2p > 1 ||
				(
					await nmDeviceProp(`p2p-dev-${parentIfname}`, "GENERAL.STATE")
				)?.[0] !== "30 (disconnected)"
			)
				return undefined;
			continue;
		}
		if (!name) return undefined;
		if (name === parentIfname) {
			if (type !== "managed") return undefined;
			parentSeen = true;
			continue;
		}
		if (name === ifname) {
			if (type !== "managed") return undefined;
			targetSeen = true;
			admittedWireless = { ifindex: index, wdev };
			continue;
		}
		const flags = await radioIdentityReaders.readText(
			`/sys/class/net/${name}/flags`,
		);
		if (!flags || !/^0x[0-9a-f]+$/i.test(flags.trim())) return undefined;
		if ((Number(flags) & 1) !== 0) return undefined;
	}
	const phyDump = await interfaceRunner("iw", ["phy", phy, "info"]);
	// Bind the admitted object here; later samples must be this same live leg.
	if (
		!parentSeen ||
		(existing &&
			(!targetSeen ||
				admittedWireless?.ifindex !== String(existing.lifetime.ifindex) ||
				!admittedWireless.wdev))
	)
		return undefined;
	if (!previous && stored) {
		if (!admittedWireless) return undefined;
		const witnessed = await stored.firstWireless;
		if (
			witnessed?.ifindex !== admittedWireless.ifindex ||
			witnessed?.wdev !== admittedWireless.wdev
		)
			return undefined;
	}
	// NM initializes the AP leg as a second managed interface before switching its role.
	if (
		!fittingApStaCombination(phyDump, roles, {
			managed: 2,
			ap: 0,
			"p2p-device": 1,
		}) ||
		!admitted()
	)
		return undefined;
	if (existing && !(await idleTarget(ifname))) return undefined;
	if (
		existing &&
		(await interfaceRunner("iw", ["dev", ifname, "station", "dump"])).trim() !==
			""
	)
		return undefined;
	if (!(await connectionsPermitAdoption(parentIfname, ifname)) || !admitted())
		return undefined;
	const creationPermit = async (wireless: CreatedInterface) => {
		const sampled = await sampleRadio(ifname, radioIdentityReaders, undefined);
		return Boolean(
			sampled &&
				sampled.lifetime.phyPath === parent.lifetime.phyPath &&
				sampled.lifetime.wiphy === parent.lifetime.wiphy &&
				(await currentTarget(ifname, {
					boot,
					parent: parent.lifetime,
					target: sampled.lifetime,
					wireless,
					parentIfname,
					parentIncarnation: parentIdentity.incarnation,
				})) &&
				(await connectionsPermitAdoption(parentIfname, ifname)),
		);
	};
	const target = await ensureConcurrentApInterface(
		parentIfname,
		admitted,
		existing ? false : creationPermit,
	);
	// A leg appearing after absence was admitted is foreign, never a borrowed target.
	if (!target || target.created !== !existing) return undefined;
	let retained = false;
	try {
		const sampled = await sampleRadio(ifname, radioIdentityReaders, undefined);
		const info = await interfaceRunner("iw", ["dev", ifname, "info"]);
		const wireless = interfaceIdentity(info);
		const policy = (await nmDeviceProp(ifname, "GENERAL.AUTOCONNECT"))?.[0];
		if (
			!sampled ||
			!wireless ||
			(policy !== "yes" && policy !== "no") ||
			!(await idleTarget(ifname))
		)
			return undefined;
		if (
			existing &&
			(!sameLifetime(sampled.lifetime, existing.lifetime) ||
				wireless.ifindex !== admittedWireless?.ifindex ||
				wireless.wdev !== admittedWireless?.wdev)
		)
			return undefined;
		if (
			target.created &&
			!(await revalidateCreatedConcurrentApInterface(target, wireless))
		)
			return undefined;
		const priorAutoconnect =
			previous?.priorAutoconnect ?? (policy === "no" ? undefined : policy);
		const record: TargetRecord = {
			boot,
			parent: parent.lifetime,
			target: sampled.lifetime,
			wireless,
			parentIfname,
			parentIncarnation: parentIdentity.incarnation,
			...(priorAutoconnect !== undefined ? { priorAutoconnect } : {}),
		};
		targetRecords.set(target, record);
		const authorized = async () =>
			(await currentTarget(ifname, record)) &&
			(await connectionsPermitAdoption(parentIfname, ifname)) &&
			admitted();
		if (!(await authorized())) return undefined;
		selectedTargets.set(ifname, {
			boot,
			first: stored?.first ?? sampled.lifetime,
			record,
		});
		if (policy !== "no") {
			await interfaceRunner("nmcli", [
				"device",
				"set",
				ifname,
				"autoconnect",
				"no",
			]);
		}
		if (!(await authorized())) return undefined;
		retained = true;
		return target;
	} finally {
		if (!retained) {
			if (target.created) await releaseCreatedConcurrentApInterface(target);
			else await releaseConcurrentApInterface(ifname);
		}
	}
}
