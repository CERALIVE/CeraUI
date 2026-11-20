/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { logger } from "../../helpers/logger.ts";
import { argMatch, ID_RE } from "../../helpers/run.ts";
import { isQualifiedNmManagedHybrid } from "./wifi-ap-sta-capability.ts";
import {
	readConcurrentBootId as bootIdReader,
	runConcurrentInterface as interfaceRunner,
	setConcurrentInterfaceDepsForTest,
} from "./wifi-concurrent-interface-io.ts";
import { wifiDeviceListGetMacAddress } from "./wifi-device-list.ts";
import {
	type HybridLegIdentity,
	hybridDiagnosticTime,
	hybridIwLegIdentity,
	hybridLegIdentity,
} from "./wifi-hybrid-target-diagnostics.ts";
import {
	type CreatedInterface,
	concurrentApIfname,
	interfaceIdentity,
	isConcurrentApIfname,
	isSupportedWifiIfname,
} from "./wifi-interface-creation.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import {
	type RadioIdentity,
	type RadioLifetime,
	radioIdentityReaders,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { sampleRadio } from "./wifi-radio-read-budget.ts";

export type TargetRecord = {
	readonly boot: string;
	readonly parent: RadioLifetime;
	readonly target: RadioLifetime;
	readonly wireless: CreatedInterface;
	readonly parentIfname: string;
	readonly parentIncarnation: string;
	readonly priorAutoconnect?: string;
};

type StoredTarget = {
	readonly boot: string;
	readonly first: RadioLifetime | undefined;
	readonly firstWireless?: {
		readonly read: Promise<CreatedInterface | undefined>;
		evidence: HybridLegIdentity;
	};
	readonly record?: TargetRecord;
};

export const selectedTargets = new Map<string, StoredTarget>();

export const targetRecords = new WeakMap<object, TargetRecord>();

let discoveryBoot: string | null | undefined;
let firstDiscoveryNames: ReadonlySet<string> | undefined;

export function wasConcurrentTargetListed(ifname: string): boolean | null {
	return firstDiscoveryNames?.has(ifname) ?? null;
}

/** First complete discovery is an immutable same-boot identity witness, not adoption. */
export async function observeConcurrentInterfacesAtFirstDiscovery(
	names: readonly string[],
	identities: ReadonlyMap<string, RadioIdentity>,
): Promise<void> {
	if (discoveryBoot !== undefined) return;
	const boot = (await bootIdReader())?.trim();
	if (discoveryBoot !== undefined) return;
	discoveryBoot = boot || null;
	firstDiscoveryNames = new Set(names);
	if (boot)
		for (const name of names) {
			if (!isConcurrentApIfname(name)) continue;
			const parent = names.find((entry) => concurrentApIfname(entry) === name);
			const first = identities.get(name)?.lifetime;
			let firstWireless: StoredTarget["firstWireless"];
			if (parent && ID_RE.test(name) && isQualifiedNmManagedHybrid(parent)) {
				const read = interfaceRunner("iw", ["dev", name, "info"]).then(
					(info) => {
						const wireless = interfaceIdentity(info);
						if (firstWireless)
							firstWireless.evidence = {
								...hybridIwLegIdentity(info, first),
								ifindex: first?.ifindex ?? null,
								wiphy: first?.wiphy ?? null,
							};
						return wireless;
					},
					() => {
						if (firstWireless)
							firstWireless.evidence = hybridLegIdentity(
								name,
								first,
								undefined,
								"unavailable",
							);
						return undefined;
					},
				);
				firstWireless = {
					read,
					evidence: hybridLegIdentity(name, first, undefined, "pending"),
				};
			}
			selectedTargets.set(name, {
				boot,
				first,
				...(firstWireless ? { firstWireless } : {}),
			});
		}
	for (const parentIfname of firstDiscoveryNames) {
		if (
			!isSupportedWifiIfname(parentIfname) ||
			!ID_RE.test(parentIfname) ||
			!isQualifiedNmManagedHybrid(parentIfname)
		)
			continue;
		const targetIfname = concurrentApIfname(parentIfname);
		const targetListed = firstDiscoveryNames.has(targetIfname);
		const identity = targetListed ? identities.get(targetIfname) : undefined;
		const firstWireless = selectedTargets.get(targetIfname)?.firstWireless;
		const fields = {
			event: "wifi-hybrid-first-discovery",
			parentIfname,
			targetIfname,
			targetListed,
			operationalMac: targetListed
				? (normalizeMacAddress(wifiDeviceListGetMacAddress(targetIfname)) ??
					null)
				: null,
			permanentMac: identity?.permanentMac ?? null,
			physicalPath: identity?.lifetime?.phyPath ?? null,
			ifindex: identity?.lifetime?.ifindex ?? null,
			wiphy: identity?.lifetime?.wiphy ?? null,
			bootId: boot || null,
			...hybridDiagnosticTime(),
		};
		const log = () =>
			logger.info("Wi-Fi hybrid target at first discovery", {
				...fields,
				wdev: firstWireless?.evidence.wdev ?? null,
				iwIfindex: firstWireless?.evidence.iwIfindex ?? null,
				wirelessStatus: firstWireless?.evidence.wirelessStatus ?? "not-read",
			});
		// The diagnostic follows the original witness read without holding discovery.
		if (firstWireless) void firstWireless.read.then(log);
		else log();
	}
}

export function sameLifetime(
	a: RadioLifetime | undefined,
	b: RadioLifetime,
): boolean {
	return (
		a?.ifindex === b.ifindex && a.wiphy === b.wiphy && a.phyPath === b.phyPath
	);
}

export async function currentTarget(
	ifname: string,
	record: TargetRecord,
	observe?: (identity: HybridLegIdentity) => void,
): Promise<boolean> {
	return (await observeTarget(ifname, record, observe)) === "current";
}

/** A failed probe is not proof of loss; only definite replacement or kernel absence retires a claim. */
export async function observeTarget(
	ifname: string,
	record: TargetRecord,
	observe?: (identity: HybridLegIdentity) => void,
): Promise<"current" | "retired" | "unseen" | "unknown"> {
	const boot = await bootIdReader();
	const parent = await sampleRadio(
		record.parentIfname,
		radioIdentityReaders,
		undefined,
	);
	const target = await sampleRadio(ifname, radioIdentityReaders, undefined);
	const identity = wifiRadioIdentity.state.rows.get(record.parentIfname);
	if (
		(boot?.trim() && boot.trim() !== record.boot) ||
		(identity && identity.incarnation !== record.parentIncarnation) ||
		(parent && !sameLifetime(parent.lifetime, record.parent)) ||
		(target && !sameLifetime(target.lifetime, record.target))
	) {
		observe?.(hybridLegIdentity(target && ifname, target?.lifetime, undefined));
		return "retired";
	}
	if (
		boot?.trim() !== record.boot ||
		identity?.incarnation !== record.parentIncarnation ||
		(!parent?.macReadFailed &&
			parent?.permanentMac !== identity?.permanentMac) ||
		!parent ||
		!target
	) {
		observe?.(hybridLegIdentity(target && ifname, target?.lifetime, undefined));
		return target ? "unknown" : "unseen";
	}
	const info = await interfaceRunner("iw", [
		"dev",
		argMatch(ID_RE, ifname),
		"info",
	]).catch(() => "");
	const wireless = interfaceIdentity(info);
	observe?.(hybridIwLegIdentity(info, target?.lifetime));
	if (
		wireless &&
		(wireless.ifindex !== record.wireless.ifindex ||
			wireless.wdev !== record.wireless.wdev)
	)
		return "retired";
	return wireless?.ifindex === record.wireless.ifindex &&
		Number(wireless.ifindex) === record.target.ifindex &&
		Number(/^\s*wiphy\s+(\d+)\s*$/m.exec(info)?.[1]) === record.target.wiphy &&
		/^\s*Interface\s+(\S+)\s*$/m.exec(info)?.[1] === ifname &&
		/^\s*type\s+managed\s*$/m.test(info) &&
		wireless.wdev === record.wireless.wdev &&
		wifiRadioIdentity.state.rows.get(record.parentIfname)?.incarnation ===
			record.parentIncarnation
		? "current"
		: "unknown";
}

/** Observation fences reactivation, but never grants creation or deletion authority. */
export async function readHybridTargetIdentity(
	parent: string,
	target: string,
): Promise<string | undefined> {
	const parentSample = await sampleRadio(
		parent,
		radioIdentityReaders,
		undefined,
	);
	const targetSample = await sampleRadio(
		target,
		radioIdentityReaders,
		undefined,
	);
	const info = await interfaceRunner("iw", [
		"dev",
		argMatch(ID_RE, target),
		"info",
	]).catch(() => "");
	const identity = interfaceIdentity(info);
	const after = await sampleRadio(target, radioIdentityReaders, undefined);
	const incarnation = wifiRadioIdentity.state.rows.get(parent)?.incarnation;
	if (
		!parentSample ||
		!incarnation ||
		!targetSample ||
		!identity ||
		!sameLifetime(after?.lifetime, targetSample.lifetime) ||
		parentSample.lifetime.phyPath !== targetSample.lifetime.phyPath ||
		parentSample.lifetime.wiphy !== targetSample.lifetime.wiphy ||
		Number(identity.ifindex) !== targetSample.lifetime.ifindex ||
		Number(/^\s*wiphy\s+(\d+)\s*$/m.exec(info)?.[1]) !==
			targetSample.lifetime.wiphy ||
		/^\s*Interface\s+(\S+)\s*$/m.exec(info)?.[1] !== target
	)
		return undefined;
	return JSON.stringify([
		incarnation,
		parentSample.lifetime,
		targetSample.lifetime,
		identity.wdev,
	]);
}

export function matchesConcurrentDiscoveryBoot(boot: string): boolean {
	return boot === discoveryBoot;
}

export function resetConcurrentInterfaceDepsForTest(): void {
	setConcurrentInterfaceDepsForTest(null, null);
	selectedTargets.clear();
	discoveryBoot = undefined;
	firstDiscoveryNames = undefined;
}
