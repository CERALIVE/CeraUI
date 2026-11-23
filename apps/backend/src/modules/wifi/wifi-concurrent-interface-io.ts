/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { readFileSync } from "node:fs";
import { logger } from "../../helpers/logger.ts";
import { argMatch, ID_RE, run } from "../../helpers/run.ts";
import { nmDeviceProp } from "../network/network-manager.ts";
import { runIw } from "./regdomain.ts";

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

const defaultBootIdReader = async () => {
	try {
		// This tiny proc read must not leave discovery waiting on an I/O task.
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error) return undefined;
		throw error;
	}
};

let bootIdReader = defaultBootIdReader;

export const runConcurrentInterface: InterfaceRunner = (command, args) =>
	interfaceRunner(command, args);
export const waitForConcurrentInterface: InterfaceWaiter = (ifname) =>
	interfaceWaiter(ifname);
export const readConcurrentBootId = () => bootIdReader();

export async function idleTarget(
	ifname: string,
	observe?: (props: string[] | undefined) => void,
): Promise<boolean> {
	const props = await nmDeviceProp(
		ifname,
		"GENERAL.STATE,GENERAL.NM-MANAGED,GENERAL.CON-UUID",
	);
	observe?.(props);
	return (
		props?.[0] === "30 (disconnected)" &&
		props[1] === "yes" &&
		(props[2] === "" || props[2] === "--")
	);
}

export async function setConcurrentAutoconnect(
	ifname: string,
	value: string,
	matchesIdentity: () => Promise<boolean>,
	beforeWrite?: () => Promise<boolean>,
): Promise<boolean> {
	const name = argMatch(ID_RE, ifname);
	const previous = (await nmDeviceProp(name, "GENERAL.AUTOCONNECT"))?.[0];
	if (
		(previous !== "yes" && previous !== "no") ||
		(beforeWrite && !(await beforeWrite())) ||
		!(await matchesIdentity())
	)
		return false;
	let matches = false;
	try {
		await interfaceRunner("nmcli", [
			"device",
			"set",
			name,
			"autoconnect",
			value,
		]);
	} finally {
		matches = await matchesIdentity();
		// NM addresses this write only by name; undo our value if the object changed during that call.
		if (!matches && previous !== value) {
			const metadata = {
				ifname: name,
				previousAutoconnect: previous,
				writtenAutoconnect: value,
				reason: "identity-lost",
			};
			const current = (await nmDeviceProp(name, "GENERAL.AUTOCONNECT"))?.[0];
			if (current !== "yes" && current !== "no") {
				logger.error(
					"Wi-Fi hybrid autoconnect compensation read unavailable",
					metadata,
				);
			} else if (current === value) {
				logger.warn("Wi-Fi hybrid autoconnect compensating restore", metadata);
				try {
					await interfaceRunner("nmcli", [
						"device",
						"set",
						name,
						"autoconnect",
						previous,
					]);
				} catch {
					logger.error(
						"Wi-Fi hybrid autoconnect compensating restore failed",
						metadata,
					);
				}
			}
		}
	}
	return matches;
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
