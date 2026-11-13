/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { logger } from "../../helpers/logger.ts";
import {
	argMatch,
	ID_RE,
	RunAbortError,
	RunTimeoutError,
} from "../../helpers/run.ts";
import { nmDeviceProp } from "../network/network-manager.ts";
import { runIw } from "./regdomain.ts";
import {
	type CreatedInterface,
	createdInterfaceReceipt,
} from "./wifi-interface-creation.ts";

type InterfaceRunner = (command: string, args: string[]) => Promise<string>;
type InterfaceWaiter = (ifname: string) => Promise<boolean>;

const defaultRunner: InterfaceRunner = (_command, args) => runIw(args);
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
	const target: ConcurrentApInterface = {
		ifname,
		created: true,
		type: "managed",
	};
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
	try {
		await interfaceRunner("iw", ["dev", argMatch(ID_RE, ifname), "del"]);
	} catch {
		return;
	}
}

export function setConcurrentInterfaceDepsForTest(
	runner: InterfaceRunner | null,
	waiter: InterfaceWaiter | null,
): void {
	interfaceRunner = runner ?? defaultRunner;
	interfaceWaiter = waiter ?? defaultWaiter;
}

export function resetConcurrentInterfaceDepsForTest(): void {
	interfaceRunner = defaultRunner;
	interfaceWaiter = defaultWaiter;
}
