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
	setConcurrentAutoconnect,
} from "./wifi-concurrent-interface-io.ts";
import {
	type AllocationFailure,
	type HybridLegIdentity,
	hybridIwLegIdentity,
	hybridLegIdentity,
} from "./wifi-hybrid-target-diagnostics.ts";
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
	onRefusal?: (reason: AllocationFailure) => void,
	creation?: {
		readonly beforeCreate: () => Promise<boolean>;
		readonly beforePolicy?: (() => Promise<boolean>) | undefined;
		readonly preserveDevicePolicy?: boolean;
		readonly phy?: number;
	},
): Promise<ConcurrentApInterface | undefined> {
	const parent = argMatch(ID_RE, parentIfname);
	const ifname = argMatch(ID_RE, concurrentApIfname(parentIfname));
	const refuse = (reason: AllocationFailure): undefined => {
		onRefusal?.(reason);
		return undefined;
	};
	if (!admitted()) return refuse("admission-lost-before-lookup");
	const info = await interfaceRunner("iw", ["dev", ifname, "info"]).catch(
		() => undefined,
	);
	if (!admitted()) return refuse("admission-lost-after-lookup");
	if (info !== undefined) {
		if (!/^\s*type\s+managed\s*$/m.test(info))
			return refuse("borrowed-role-not-managed");
		const visible = await interfaceWaiter(ifname);
		if (!admitted()) return refuse("admission-lost-after-borrowed-wait");
		if (!visible) return refuse("borrowed-nm-not-visible");
		return { ifname, created: false, type: "managed" };
	}
	if (creationPermit === false) return refuse("create-forbidden");
	if (creation && (!(await creation.beforeCreate()) || !admitted()))
		return refuse("admission-lost-after-lookup");
	const target: ConcurrentApInterface = {
		ifname,
		created: true,
		type: "managed",
	};
	if (creationPermit) cleanupChecks.set(target, creationPermit);
	let handedOff = false;
	let createCommandFailed = false;
	try {
		// shortcut: iw can bind to a wiphy index, not an atomic parent lifetime.
		// Wiphy index reuse after the proof requires kernel-side lifetime binding.
		const receipt = await interfaceRunner("iw", [
			"--debug",
			...(creation?.phy === undefined
				? ["dev", parent]
				: [`phy#${creation.phy}`]),
			"interface",
			"add",
			ifname,
			"type",
			"managed",
		]).catch((error: unknown) => {
			createCommandFailed = true;
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
			return refuse("creation-receipt-unavailable");
		}
		createdInterfaces.set(target, identity);
		if (!admitted()) return refuse("admission-lost-after-create");
		// This read observes the captured object; it never grants ownership.
		const readIdentity = () => interfaceRunner("iw", ["dev", ifname, "info"]);
		const matchesReceipt = (info: string) => {
			const current = interfaceIdentity(info);
			return (
				current?.ifindex === identity.ifindex &&
				current.wdev === identity.wdev &&
				/^\s*Interface\s+(\S+)\s*$/m.exec(info)?.[1] === ifname
			);
		};
		const infoAfterCreate = await readIdentity().catch(() => undefined);
		if (infoAfterCreate === undefined)
			return refuse("created-identity-query-failed");
		if (!matchesReceipt(infoAfterCreate))
			return refuse("created-identity-mismatch");
		const matchesIdentity = async () =>
			matchesReceipt(await readIdentity().catch(() => ""));
		const visible = await interfaceWaiter(ifname);
		if (!admitted()) return refuse("admission-lost-after-created-wait");
		if (visible) {
			if (!(await matchesIdentity()))
				return refuse("created-identity-changed-after-wait");
			if (creationPermit && !(await creationPermit(identity)))
				return refuse("creation-permit-refused");
			if (
				!creation?.preserveDevicePolicy &&
				!(await setConcurrentAutoconnect(
					ifname,
					"no",
					matchesIdentity,
					creation?.beforePolicy,
				))
			)
				return refuse("created-autoconnect-refused");
			if (!admitted())
				return refuse("admission-lost-after-created-autoconnect");
			handedOff = true;
			return target;
		}
	} catch {
		return refuse(
			createCommandFailed
				? "create-command-failed"
				: "allocation-read-or-write-failed",
		);
	} finally {
		if (!handedOff) await releaseCreatedConcurrentApInterface(target);
	}
	return refuse("created-nm-not-visible");
}

export async function revalidateCreatedConcurrentApInterface(
	target: {
		readonly ifname: string;
	},
	expected?: CreatedInterface,
	observe?: (witness: HybridLegIdentity, observed?: HybridLegIdentity) => void,
): Promise<boolean> {
	const created = createdInterfaces.get(target);
	if (observe) observe(hybridLegIdentity(target.ifname, undefined, created));

	if (
		!created ||
		(expected &&
			(created.ifindex !== expected.ifindex || created.wdev !== expected.wdev))
	)
		return false;

	const check = cleanupChecks.get(target);

	if (check && !(await check(created))) return false;

	const ifname = target.ifname;
	if (!ID_RE.test(ifname)) return false;
	const info = await interfaceRunner("iw", ["dev", ifname, "info"]).catch(
		() => "",
	);

	const current = interfaceIdentity(info);
	if (observe)
		observe(
			hybridLegIdentity(target.ifname, undefined, created),
			hybridIwLegIdentity(info),
		);

	return (
		current?.ifindex === created.ifindex &&
		current.wdev === created.wdev &&
		/^\s*Interface\s+(\S+)\s*$/m.exec(info)?.[1] === ifname &&
		/^\s*type\s+managed\s*$/m.test(info) &&
		(await idleTarget(ifname))
	);
}
