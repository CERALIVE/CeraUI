/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { ID_RE } from "../../helpers/run.ts";
import { nmDeviceProp } from "../network/network-manager.ts";
import {
	fittingApStaCombination,
	isQualifiedNmManagedHybrid,
} from "./wifi-ap-sta-capability.ts";
import {
	type ConcurrentApInterface,
	ensureConcurrentApInterface,
	revalidateCreatedConcurrentApInterface,
} from "./wifi-concurrent-interface-creation.ts";
import {
	readConcurrentBootId as bootIdReader,
	idleTarget,
	runConcurrentInterface as interfaceRunner,
	setConcurrentAutoconnect,
} from "./wifi-concurrent-interface-io.ts";
import {
	type AllocationFailure,
	type HybridLegIdentity,
	type HybridTargetFacts,
	type HybridTargetReason,
	type HybridTargetRefusal,
	hybridIwLegIdentity,
	hybridLegIdentity,
	nmStateCode,
} from "./wifi-hybrid-target-diagnostics.ts";
import {
	connectionsPermitAdoption,
	releaseConcurrentApInterface,
	releaseCreatedHybridTarget,
} from "./wifi-hybrid-target-policy.ts";
import {
	currentTarget,
	matchesConcurrentDiscoveryBoot,
	sameLifetime,
	selectedTargets,
	type TargetRecord,
	targetRecords,
	wasConcurrentTargetListed,
} from "./wifi-hybrid-target-record.ts";
import {
	type CreatedInterface,
	concurrentApIfname,
	interfaceIdentity,
} from "./wifi-interface-creation.ts";
import {
	type RadioLifetime,
	radioIdentityReaders,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { sampleRadio } from "./wifi-radio-read-budget.ts";

/** Select one coherent qualified leg. Observation never becomes creation ownership. */
export async function selectConcurrentApInterface(
	parentIfname: string,
	admitted: () => boolean = () => true,
	createMissing = false,
	onRefusal?: (refusal: HybridTargetRefusal) => void,
): Promise<ConcurrentApInterface | undefined> {
	const ifname = concurrentApIfname(parentIfname);
	const facts: HybridTargetFacts = {
		targetListed: wasConcurrentTargetListed(ifname),
		targetSampled: null,
		qualified: null,
		samePermanentMac: null,
		samePhysicalPath: null,
		profileOwnership: null,
	};
	const refuse = (
		reasonCode: HybridTargetReason,
		detail?: Partial<
			Omit<HybridTargetRefusal, keyof HybridTargetFacts | "reasonCode">
		>,
	): undefined => {
		onRefusal?.({ ...facts, ...detail, reasonCode });
		return undefined;
	};
	if (!admitted()) return refuse("admission-lost");
	facts.qualified = isQualifiedNmManagedHybrid(parentIfname);
	if (!facts.qualified) return refuse("radio-unqualified");
	const boot = (await bootIdReader())?.trim();
	const parent = await sampleRadio(
		parentIfname,
		radioIdentityReaders,
		undefined,
	);
	if (!boot) return refuse("boot-id-unavailable");
	if (!matchesConcurrentDiscoveryBoot(boot))
		return refuse("discovery-boot-mismatch");
	if (!parent) return refuse("parent-sample-unavailable");
	if (!admitted()) return refuse("admission-lost-after-parent-sample");
	const parentIdentity = wifiRadioIdentity.state.rows.get(parentIfname);
	facts.samePermanentMac =
		parent.macReadFailed || !parentIdentity
			? null
			: parent.permanentMac === parentIdentity.permanentMac;
	if (
		!parentIdentity?.lifetime ||
		!sameLifetime(parent.lifetime, parentIdentity.lifetime) ||
		facts.samePermanentMac === false
	)
		return refuse("parent-identity-mismatch", {
			subReason: !parentIdentity?.lifetime
				? "parent-lifetime-unavailable"
				: !sameLifetime(parent.lifetime, parentIdentity.lifetime)
					? "parent-lifetime-mismatch"
					: "permanent-mac-mismatch",
		});
	const existing = await sampleRadio(ifname, radioIdentityReaders, undefined);
	facts.targetSampled = existing !== undefined;
	if (!existing && !createMissing) return refuse("creation-disabled");
	facts.samePhysicalPath = existing
		? existing.lifetime.phyPath === parent.lifetime.phyPath
		: null;
	if (
		existing &&
		(facts.samePhysicalPath === false ||
			existing.lifetime.wiphy !== parent.lifetime.wiphy)
	)
		return refuse("target-phy-mismatch");
	const stored = selectedTargets.get(ifname);
	const initialWitness = () =>
		stored?.firstWireless?.evidence ??
		hybridLegIdentity(stored && ifname, stored?.first, undefined);
	const initialObservation = hybridLegIdentity(
		existing && ifname,
		existing?.lifetime,
		undefined,
	);
	if (
		stored &&
		(stored.boot !== boot ||
			!existing ||
			!sameLifetime(stored.first, existing.lifetime))
	)
		return refuse("target-witness-mismatch", {
			subReason:
				stored.boot !== boot
					? "stored-boot-mismatch"
					: !existing
						? "live-target-unavailable"
						: "stored-lifetime-mismatch",
			witness: initialWitness(),
			observed: initialObservation,
		});
	const previous = stored?.record;
	const retainedWitness = () =>
		previous
			? hybridLegIdentity(ifname, previous.target, previous.wireless)
			: initialWitness();
	let retainedObservation = initialObservation;
	if (
		previous &&
		!(await currentTarget(ifname, previous, (observed) => {
			retainedObservation = observed;
		}))
	)
		return refuse("retained-target-changed", {
			witness: retainedWitness(),
			observed: retainedObservation,
		});
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
			const state =
				++p2p > 1
					? undefined
					: (
							await nmDeviceProp(`p2p-dev-${parentIfname}`, "GENERAL.STATE")
						)?.[0];
			if (state !== "30 (disconnected)")
				return refuse("p2p-not-idle", {
					p2pCount: p2p,
					p2pNmState: nmStateCode(state),
				});
			continue;
		}
		if (!name) return refuse("unnamed-phy-interface");
		if (name === parentIfname) {
			if (type !== "managed") return refuse("parent-role-mismatch");
			parentSeen = true;
			continue;
		}
		if (name === ifname) {
			if (type !== "managed") return refuse("target-role-mismatch");
			targetSeen = true;
			admittedWireless = { ifindex: index, wdev };
			continue;
		}
		const flags = await radioIdentityReaders.readText(
			`/sys/class/net/${name}/flags`,
		);
		const peerIfname = ID_RE.test(name) ? name : null;
		if (!flags || !/^0x[0-9a-f]+$/i.test(flags.trim()))
			return refuse("peer-flags-unavailable", { peerIfname });
		if ((Number(flags) & 1) !== 0)
			return refuse("peer-interface-up", { peerIfname });
	}
	const phyDump = await interfaceRunner("iw", ["phy", phy, "info"]);
	// Bind the admitted object here; later samples must be this same live leg.
	if (!parentSeen) return refuse("parent-not-in-iw");
	if (
		existing &&
		(!targetSeen ||
			admittedWireless?.ifindex !== String(existing.lifetime.ifindex) ||
			!admittedWireless.wdev)
	)
		return refuse(
			!previous && stored && !admittedWireless
				? "first-wireless-observation-unavailable"
				: "target-iw-identity-mismatch",
			{
				subReason: !targetSeen
					? "target-missing-in-iw"
					: admittedWireless?.ifindex !== String(existing.lifetime.ifindex)
						? "iw-ifindex-mismatch"
						: "iw-wdev-unavailable",
				witness: retainedWitness(),
				observed: hybridLegIdentity(
					existing && ifname,
					existing.lifetime,
					admittedWireless,
					targetSeen ? "observed" : "unavailable",
				),
			},
		);
	// A stored witness requires a live sample that passed the iw identity guard above.
	if (!previous && stored && admittedWireless) {
		const witnessed = await stored.firstWireless?.read;
		if (
			witnessed?.ifindex !== admittedWireless.ifindex ||
			witnessed?.wdev !== admittedWireless.wdev
		)
			return refuse("first-wireless-witness-mismatch", {
				witness: initialWitness(),
				observed: hybridLegIdentity(
					ifname,
					existing?.lifetime,
					admittedWireless,
				),
			});
	}
	// NM initializes the AP leg as a second managed interface before switching its role.
	if (
		!fittingApStaCombination(phyDump, roles, {
			managed: 2,
			ap: 0,
			"p2p-device": 1,
		})
	)
		return refuse("interface-combination-refused");
	if (!admitted()) return refuse("admission-lost-after-combination");
	let nmTarget: string[] | undefined;
	const readIdle = () =>
		idleTarget(ifname, (props) => {
			nmTarget = props;
		});
	const nmFacts = () => ({
		targetNmState: nmStateCode(nmTarget?.[0]),
		targetNmManaged:
			nmTarget?.[1] === "yes" ? true : nmTarget?.[1] === "no" ? false : null,
		targetHasActiveConnection:
			nmTarget?.[2] === undefined
				? null
				: nmTarget[2] !== "" && nmTarget[2] !== "--",
	});
	if (existing && !(await readIdle()))
		return refuse("existing-target-not-idle", nmFacts());
	if (
		existing &&
		(await interfaceRunner("iw", ["dev", ifname, "station", "dump"])).trim() !==
			""
	)
		return refuse("existing-target-has-stations", nmFacts());
	const profilesPermit = async () => {
		facts.profileOwnership = await connectionsPermitAdoption(
			parentIfname,
			ifname,
		);
		return facts.profileOwnership;
	};
	if (!(await profilesPermit())) return refuse("profile-ownership-unproven");
	if (!admitted()) return refuse("admission-lost-after-profile-check");
	let creationLifetime: RadioLifetime | undefined;
	const creationPermit = async (wireless: CreatedInterface) => {
		const sampled = await sampleRadio(ifname, radioIdentityReaders, undefined);
		creationLifetime ??= sampled?.lifetime;
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
				(await profilesPermit()),
		);
	};
	let allocationFailure: AllocationFailure | "allocator-unreported" =
		"allocator-unreported";
	const target = await ensureConcurrentApInterface(
		parentIfname,
		admitted,
		existing ? false : creationPermit,
		(reason) => {
			allocationFailure = reason;
		},
	);
	// A leg appearing after absence was admitted is foreign, never a borrowed target.
	if (!target)
		return refuse("target-allocation-failed", { subReason: allocationFailure });
	if (target.created !== !existing)
		return refuse("target-allocation-origin-mismatch");
	let retained = false;
	try {
		const sampled = await sampleRadio(ifname, radioIdentityReaders, undefined);
		const info = await interfaceRunner("iw", ["dev", ifname, "info"]);
		const wireless = interfaceIdentity(info);
		const policy = (await nmDeviceProp(ifname, "GENERAL.AUTOCONNECT"))?.[0];
		nmTarget = undefined;
		if (
			!sampled ||
			!wireless ||
			(policy !== "yes" && policy !== "no") ||
			!(await readIdle())
		)
			return refuse("allocated-target-not-ready", {
				...nmFacts(),
				subReason: !sampled
					? "target-sample-unavailable"
					: !wireless
						? "target-wireless-identity-unavailable"
						: policy !== "yes" && policy !== "no"
							? "target-autoconnect-unavailable"
							: "allocated-target-not-idle",
				targetAutoconnect:
					policy === "yes" || policy === "no" ? policy : "unavailable",
			});
		if (
			existing &&
			(!sameLifetime(sampled.lifetime, existing.lifetime) ||
				wireless.ifindex !== admittedWireless?.ifindex ||
				wireless.wdev !== admittedWireless?.wdev)
		)
			return refuse("borrowed-target-changed", {
				witness: hybridLegIdentity(ifname, existing.lifetime, admittedWireless),
				observed: hybridIwLegIdentity(info, sampled.lifetime),
			});
		let createdWitness = hybridLegIdentity(ifname, undefined, undefined);
		let createdObservation: HybridLegIdentity | undefined;
		if (
			target.created &&
			!(await revalidateCreatedConcurrentApInterface(
				target,
				wireless,
				(witness, observed) => {
					createdWitness = witness;
					createdObservation = observed;
				},
			))
		)
			return refuse("created-target-changed", {
				witness: {
					...createdWitness,
					wiphy: creationLifetime?.wiphy ?? null,
					phyPath: creationLifetime?.phyPath ?? null,
				},
				observed:
					createdObservation === undefined
						? hybridIwLegIdentity(info, sampled.lifetime)
						: { ...createdObservation, phyPath: sampled.lifetime.phyPath },
			});
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
			(await profilesPermit()) &&
			admitted();
		if (!(await authorized())) return refuse("target-changed-before-policy");
		selectedTargets.set(ifname, {
			boot,
			first: stored?.first ?? sampled.lifetime,
			record,
		});
		if (policy !== "no") {
			if (
				!(await setConcurrentAutoconnect(ifname, "no", () =>
					currentTarget(ifname, record),
				))
			)
				return refuse("target-autoconnect-refused");
		}
		if (!(await authorized())) return refuse("target-changed-after-policy");
		retained = true;
		return target;
	} finally {
		if (!retained) {
			if (target.created) await releaseCreatedHybridTarget(target);
			else await releaseConcurrentApInterface(ifname);
		}
	}
}
