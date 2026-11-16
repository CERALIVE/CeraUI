/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { argMatch, ID_RE } from "../../helpers/run.ts";
import { isQualifiedNmManagedHybrid } from "./wifi-ap-sta-capability.ts";
import {
	readConcurrentBootId as bootIdReader,
	runConcurrentInterface as interfaceRunner,
	setConcurrentInterfaceDepsForTest,
} from "./wifi-concurrent-interface-io.ts";
import {
	type CreatedInterface,
	concurrentApIfname,
	interfaceIdentity,
	isConcurrentApIfname,
} from "./wifi-interface-creation.ts";
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
	readonly firstWireless?: Promise<CreatedInterface | undefined>;
	readonly record?: TargetRecord;
};

export const selectedTargets = new Map<string, StoredTarget>();

export const targetRecords = new WeakMap<object, TargetRecord>();

let discoveryBoot: string | null | undefined;

/** First complete discovery is an immutable same-boot identity witness, not adoption. */
export async function observeConcurrentInterfacesAtFirstDiscovery(
	names: readonly string[],
	identities: ReadonlyMap<string, RadioIdentity>,
): Promise<void> {
	if (discoveryBoot !== undefined) return;
	const boot = (await bootIdReader())?.trim();
	if (discoveryBoot !== undefined) return;
	discoveryBoot = boot || null;
	if (!boot) return;
	for (const name of names) {
		if (!isConcurrentApIfname(name)) continue;
		const parent = names.find((entry) => concurrentApIfname(entry) === name);
		// The wdev witness is read now but never delays discovery; adoption awaits it.
		const firstWireless =
			parent && ID_RE.test(name) && isQualifiedNmManagedHybrid(parent)
				? interfaceRunner("iw", ["dev", name, "info"]).then(
						interfaceIdentity,
						() => undefined,
					)
				: undefined;
		selectedTargets.set(name, {
			boot,
			first: identities.get(name)?.lifetime,
			...(firstWireless ? { firstWireless } : {}),
		});
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
): Promise<boolean> {
	const boot = await bootIdReader();
	const parent = await sampleRadio(
		record.parentIfname,
		radioIdentityReaders,
		undefined,
	);
	const target = await sampleRadio(ifname, radioIdentityReaders, undefined);
	const identity = wifiRadioIdentity.state.rows.get(record.parentIfname);
	if (
		boot?.trim() !== record.boot ||
		identity?.incarnation !== record.parentIncarnation ||
		(!parent?.macReadFailed &&
			parent?.permanentMac !== identity?.permanentMac) ||
		!sameLifetime(parent?.lifetime, record.parent) ||
		!sameLifetime(target?.lifetime, record.target)
	)
		return false;
	const info = await interfaceRunner("iw", [
		"dev",
		argMatch(ID_RE, ifname),
		"info",
	]).catch(() => "");
	const wireless = interfaceIdentity(info);
	return (
		wireless?.ifindex === record.wireless.ifindex &&
		Number(wireless.ifindex) === record.target.ifindex &&
		Number(/^\s*wiphy\s+(\d+)\s*$/m.exec(info)?.[1]) === record.target.wiphy &&
		/^\s*Interface\s+(\S+)\s*$/m.exec(info)?.[1] === ifname &&
		/^\s*type\s+managed\s*$/m.test(info) &&
		wireless.wdev === record.wireless.wdev &&
		wifiRadioIdentity.state.rows.get(record.parentIfname)?.incarnation ===
			record.parentIncarnation
	);
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
}
