/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { argMatch, ID_RE, run } from "../../helpers/run.ts";
import { nmDeviceProp } from "../network/network-manager.ts";

type InterfaceRunner = (command: string, args: string[]) => Promise<string>;
type InterfaceWaiter = (ifname: string) => Promise<boolean>;

const defaultRunner: InterfaceRunner = (command, args) => run(command, args);
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

export async function ensureConcurrentApInterface(
	parentIfname: string,
): Promise<ConcurrentApInterface | undefined> {
	const parent = argMatch(ID_RE, parentIfname);
	const ifname = argMatch(ID_RE, concurrentApIfname(parentIfname));
	const info = await interfaceRunner("iw", ["dev", ifname, "info"]).catch(
		() => undefined,
	);
	if (info !== undefined) {
		if (
			/^\s*type\s+managed\s*$/m.test(info) &&
			(await interfaceWaiter(ifname))
		) {
			return { ifname, created: false, type: "managed" };
		}
		await releaseConcurrentApInterface(ifname);
	}
	try {
		await interfaceRunner("iw", [
			"dev",
			parent,
			"interface",
			"add",
			ifname,
			"type",
			"managed",
		]);
		if (await interfaceWaiter(ifname))
			return { ifname, created: true, type: "managed" };
		await releaseConcurrentApInterface(ifname);
	} catch {
		return undefined;
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
