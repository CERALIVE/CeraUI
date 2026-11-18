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
import {
	idleTarget,
	runConcurrentInterface as interfaceRunner,
	waitForConcurrentInterface as interfaceWaiter,
} from "./wifi-concurrent-interface-io.ts";
import {
	type CreatedInterface,
	concurrentApIfname,
	createdInterfaceReceipt,
	interfaceIdentity,
} from "./wifi-interface-creation.ts";

export type ConcurrentApInterface = {
	readonly ifname: string;
	readonly created: boolean;
	readonly type: "managed";
};

const createdInterfaces = new WeakMap<object, CreatedInterface>();

const cleanupChecks = new WeakMap<
	object,
	(created: CreatedInterface) => Promise<boolean>
>();

/** Creation owns cleanup even after activation admission has been retired; true only once its object is deleted. */
export async function releaseCreatedConcurrentApInterface(target: {
	ifname: string;
	created: boolean;
}): Promise<boolean> {
	const owned = createdInterfaces.get(target);
	if (!owned) return false;
	try {
		const check = cleanupChecks.get(target);
		if (check && !(await check(owned))) return false;
		// Stable wireless-device addressing cannot delete a same-name replacement.
		await interfaceRunner("iw", ["wdev", owned.wdev, "del"]);
		createdInterfaces.delete(target);
		return true;
	} catch {
		return false;
	}
}

export async function ensureConcurrentApInterface(
	parentIfname: string,
	admitted: () => boolean = () => true,
	creationPermit?: ((created: CreatedInterface) => Promise<boolean>) | false,
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
	if (creationPermit === false) return undefined;
	const target: ConcurrentApInterface = {
		ifname,
		created: true,
		type: "managed",
	};
	if (creationPermit) cleanupChecks.set(target, creationPermit);
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
			if (creationPermit && !(await creationPermit(identity))) return undefined;
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

export async function revalidateCreatedConcurrentApInterface(
	target: {
		readonly ifname: string;
	},
	expected?: CreatedInterface,
): Promise<boolean> {
	const created = createdInterfaces.get(target);

	if (
		!created ||
		(expected &&
			(created.ifindex !== expected.ifindex || created.wdev !== expected.wdev))
	)
		return false;

	const check = cleanupChecks.get(target);

	if (check && !(await check(created))) return false;

	const info = await interfaceRunner("iw", [
		"wdev",
		created.wdev,
		"info",
	]).catch(() => "");

	const current = interfaceIdentity(info);

	return (
		current?.ifindex === created.ifindex &&
		current.wdev === created.wdev &&
		/^\s*Interface\s+(\S+)\s*$/m.exec(info)?.[1] === target.ifname &&
		/^\s*type\s+managed\s*$/m.test(info) &&
		(await idleTarget(target.ifname))
	);
}
