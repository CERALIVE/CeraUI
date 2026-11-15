/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { logger } from "../../helpers/logger.ts";
import {
	argMatch,
	ID_RE,
	RunAbortError,
	RunTimeoutError,
	run,
} from "../../helpers/run.ts";
import {
	nmConnGetFields,
	nmConnsGet,
	nmcliParseSep,
	nmDeviceProp,
} from "../network/network-manager.ts";
import { getHotspotCredentialOwners } from "./hotspot-credentials.ts";
import { runIw } from "./regdomain.ts";
import { wifiAdapterLockKey } from "./wifi-adapter-lock.ts";
import { fittingApStaCombination } from "./wifi-ap-sta-capability.ts";
import {
	type CreatedInterface,
	createdInterfaceReceipt,
} from "./wifi-interface-creation.ts";
import {
	type RadioIdentity,
	type RadioLifetime,
	radioIdentityReaders,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { sampleRadio } from "./wifi-radio-read-budget.ts";

type InterfaceRunner = (command: string, args: string[]) => Promise<string>;
type InterfaceWaiter = (ifname: string) => Promise<boolean>;

const defaultRunner: InterfaceRunner = (command, args) =>
	command === "iw" ? runIw(args) : run(command, args);
const defaultWaiter: InterfaceWaiter = async (ifname) => {
	for (let attempt = 0; attempt < 20; attempt++) {
		if ((await nmDeviceProp(ifname, "GENERAL.STATE")) !== undefined)
			return true;
		await Bun.sleep(100);
	}
	return false;
};

let interfaceRunner = defaultRunner;
let interfaceWaiter = defaultWaiter;

/** Wi-Fi name candidates; NM determines radio type, and clap AP legs are separate. */
export function isSupportedWifiIfname(ifname: string): boolean {
	return ifname.startsWith("wl");
}

export function concurrentApIfname(parentIfname: string): string {
	return `clap-${parentIfname}`.slice(0, 15);
}

export function isConcurrentApIfname(ifname: string): boolean {
	return ifname.startsWith("clap-");
}

export function concurrentHotspotBindingFields(
	ifname: string,
): Record<string, string> {
	return {
		"connection.interface-name": concurrentApIfname(ifname),
		"802-11-wireless.mac-address": "",
		"802-11-wireless-security.pmf": "disable",
	};
}

export type ConcurrentApInterface = {
	ifname: string;
	created: boolean;
	type: "managed";
};

const createdInterfaces = new WeakMap<object, CreatedInterface>();
const cleanupChecks = new WeakMap<
	object,
	(created: CreatedInterface) => Promise<boolean>
>();

type TargetRecord = {
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
	readonly record?: TargetRecord;
};
const selectedTargets = new Map<string, StoredTarget>();
const targetRecords = new WeakMap<object, TargetRecord>();
let discoveryBoot: string | null | undefined;
const defaultBootIdReader = () =>
	Bun.file("/proc/sys/kernel/random/boot_id")
		.text()
		.catch(() => undefined);
let bootIdReader = defaultBootIdReader;

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
	for (const name of names)
		if (isConcurrentApIfname(name))
			selectedTargets.set(name, {
				boot,
				first: identities.get(name)?.lifetime,
			});
}

async function connectionsPermitAdoption(
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

/** Product qualification, separate from the driver's combinations and legality. */
export function isQualifiedNmManagedHybrid(
	ifname: string,
	frequency?: number,
): boolean {
	try {
		const driver = basename(
			realpathSync(`/sys/class/net/${argMatch(ID_RE, ifname)}/device/driver`),
		);
		// Lift the frequency clause only after the corresponding band is board-qualified.
		return (
			driver === "mt7925e" &&
			(frequency === undefined || (frequency >= 2400 && frequency < 2500))
		);
	} catch {
		return false;
	}
}

function sameLifetime(a: RadioLifetime | undefined, b: RadioLifetime): boolean {
	return (
		a?.ifindex === b.ifindex && a.wiphy === b.wiphy && a.phyPath === b.phyPath
	);
}

async function currentTarget(
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

async function idleTarget(ifname: string): Promise<boolean> {
	const props = await nmDeviceProp(
		ifname,
		"GENERAL.STATE,GENERAL.NM-MANAGED,GENERAL.CON-UUID",
	);
	return (
		props?.[0] === "30 (disconnected)" &&
		props[1] === "yes" &&
		(props[2] === "" || props[2] === "--")
	);
}

/** Select one coherent qualified leg. Observation never becomes creation ownership. */
export async function selectConcurrentApInterface(
	parentIfname: string,
	admitted: () => boolean = () => true,
): Promise<ConcurrentApInterface | undefined> {
	if (!admitted() || !isQualifiedNmManagedHybrid(parentIfname))
		return undefined;
	const boot = (await bootIdReader())?.trim();
	const parent = await sampleRadio(
		parentIfname,
		radioIdentityReaders,
		undefined,
	);
	if (!boot || boot !== discoveryBoot || !parent || !admitted())
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
	if (!existing) return undefined;
	if (
		existing &&
		(existing.lifetime.phyPath !== parent.lifetime.phyPath ||
			existing.lifetime.wiphy !== parent.lifetime.wiphy)
	)
		return undefined;
	const stored = selectedTargets.get(ifname);
	if (
		stored &&
		(stored.boot !== boot || !sameLifetime(stored.first, existing.lifetime))
	)
		return undefined;
	const previous = stored?.record;
	if (previous && !(await currentTarget(ifname, previous))) return undefined;
	const phy = `phy${parent.lifetime.wiphy}`;
	const dump = await interfaceRunner("iw", ["dev"]);
	const roles: Record<string, number> = { managed: 1, ap: 1, "p2p-device": 1 };
	let currentPhy: string | undefined;
	let name: string | undefined;
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
		if (named) name = named[1];
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
			continue;
		}
		const flags = await radioIdentityReaders.readText(
			`/sys/class/net/${name}/flags`,
		);
		if (!flags || !/^0x[0-9a-f]+$/i.test(flags.trim())) return undefined;
		if ((Number(flags) & 1) !== 0) return undefined;
	}
	const phyDump = await interfaceRunner("iw", ["phy", phy, "info"]);
	if (!parentSeen || (existing && !targetSeen)) return undefined;
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
	const target = await ensureConcurrentApInterface(
		parentIfname,
		admitted,
		undefined,
		false,
	);
	if (!target || target.created) return undefined;
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
			sampled.lifetime.phyPath !== parent.lifetime.phyPath ||
			sampled.lifetime.wiphy !== parent.lifetime.wiphy
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
		if (!(await currentTarget(ifname, record)) || !admitted()) return undefined;
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
		if (!(await currentTarget(ifname, record)) || !admitted()) return undefined;
		retained = true;
		return target;
	} finally {
		if (!retained) {
			await releaseConcurrentApInterface(ifname);
		}
	}
}

function interfaceIdentity(info: string): CreatedInterface | undefined {
	const ifindex = info.match(/^\s*ifindex\s+([1-9]\d*)\s*$/m)?.[1];
	const wdev = info.match(/^\s*wdev\s+(0x[0-9a-f]+)\s*$/im)?.[1];
	return ifindex && wdev ? { ifindex, wdev } : undefined;
}

/** Creation owns cleanup even after activation admission has been retired. */
export async function releaseCreatedConcurrentApInterface(target: {
	ifname: string;
	created: boolean;
}): Promise<void> {
	const owned = createdInterfaces.get(target);
	if (!owned) return;
	try {
		const check = cleanupChecks.get(target);
		if (check && !(await check(owned))) return;
		// Stable wireless-device addressing cannot delete a same-name replacement.
		await interfaceRunner("iw", ["wdev", owned.wdev, "del"]);
		createdInterfaces.delete(target);
	} catch {
		return;
	}
}

export async function ensureConcurrentApInterface(
	parentIfname: string,
	admitted: () => boolean = () => true,
	cleanupPermitted?: (created: CreatedInterface) => Promise<boolean>,
	allowCreate = true,
): Promise<ConcurrentApInterface | undefined> {
	const parent = argMatch(ID_RE, parentIfname);
	const ifname = argMatch(ID_RE, concurrentApIfname(parentIfname));
	if (!admitted()) return undefined;
	const info = await interfaceRunner("iw", ["dev", ifname, "info"]).catch(
		() => undefined,
	);
	if (!admitted()) return undefined;
	if (info !== undefined) {
		if (!/^\s*type\s+managed\s*$/m.test(info)) return undefined;
		const visible = await interfaceWaiter(ifname);
		if (!admitted() || !visible) return undefined;
		return { ifname, created: false, type: "managed" };
	}
	if (!allowCreate) return undefined;
	const target: ConcurrentApInterface = {
		ifname,
		created: true,
		type: "managed",
	};
	if (cleanupPermitted) cleanupChecks.set(target, cleanupPermitted);
	let handedOff = false;
	try {
		const receipt = await interfaceRunner("iw", [
			"--debug",
			"dev",
			parent,
			"interface",
			"add",
			ifname,
			"type",
			"managed",
		]).catch((error: unknown) => {
			const partial =
				error instanceof RunTimeoutError || error instanceof RunAbortError
					? error.partialStderr
					: error instanceof Error &&
							"stderr" in error &&
							typeof error.stderr === "string"
						? error.stderr
						: "";
			const identity = createdInterfaceReceipt(partial, ifname);
			if (identity) createdInterfaces.set(target, identity);
			throw error;
		});
		const identity = createdInterfaceReceipt(receipt, ifname);
		if (!identity) {
			logger.warn(
				`Wi-Fi interface creation receipt unavailable for ${ifname}; refusing ownership`,
			);
			return undefined;
		}
		createdInterfaces.set(target, identity);
		if (!admitted()) return undefined;
		// This read observes the captured object; it never grants ownership.
		const createdInfo = await interfaceRunner("iw", [
			"wdev",
			identity.wdev,
			"info",
		]);
		const current = interfaceIdentity(createdInfo);
		if (
			current?.ifindex !== identity.ifindex ||
			current.wdev !== identity.wdev ||
			createdInfo.match(/^\s*Interface\s+(\S+)\s*$/m)?.[1] !== ifname
		)
			return undefined;
		const visible = await interfaceWaiter(ifname);
		if (!admitted()) return undefined;
		if (visible) {
			const readyInfo = await interfaceRunner("iw", [
				"wdev",
				identity.wdev,
				"info",
			]);
			const ready = interfaceIdentity(readyInfo);
			if (
				ready?.ifindex !== identity.ifindex ||
				ready.wdev !== identity.wdev ||
				/^\s*Interface\s+(\S+)\s*$/m.exec(readyInfo)?.[1] !== ifname
			)
				return undefined;
			await interfaceRunner("nmcli", [
				"device",
				"set",
				ifname,
				"autoconnect",
				"no",
			]);
			if (!admitted()) return undefined;
			handedOff = true;
			return target;
		}
	} catch {
		return undefined;
	} finally {
		if (!handedOff) await releaseCreatedConcurrentApInterface(target);
	}
	return undefined;
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
		if ((await nmDeviceProp(ifname, "GENERAL.AUTOCONNECT"))?.[0] !== "no")
			return;
		if (!(await connectionsPermitAdoption(record.parentIfname, ifname))) return;
		await interfaceRunner("nmcli", [
			"device",
			"set",
			argMatch(ID_RE, ifname),
			"autoconnect",
			record.priorAutoconnect,
		]);
		const { priorAutoconnect: _prior, ...released } = record;
		selectedTargets.set(ifname, { ...stored, record: released });
	} catch {
		return;
	}
}

export function setConcurrentInterfaceDepsForTest(
	runner: InterfaceRunner | null,
	waiter: InterfaceWaiter | null,
	boot?: typeof defaultBootIdReader,
): void {
	interfaceRunner = runner ?? defaultRunner;
	interfaceWaiter = waiter ?? defaultWaiter;
	bootIdReader = boot ?? (runner ? bootIdReader : defaultBootIdReader);
}

export function resetConcurrentInterfaceDepsForTest(): void {
	interfaceRunner = defaultRunner;
	interfaceWaiter = defaultWaiter;
	bootIdReader = defaultBootIdReader;
	selectedTargets.clear();
	discoveryBoot = undefined;
}
