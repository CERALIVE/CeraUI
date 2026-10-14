/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * Argv-only wrapper around the privileged `ceralive-addon-helper` root binary
 * (T27). The packaged backend runs as root; add-on lifecycle authority remains
 * in the helper, invoked here as:
 *
 *     /usr/bin/setsid -w -- /usr/bin/ceralive-addon-helper <enable|disable|refresh> [id]
 *     sudo ceralive-addon-helper status
 *
 * Design rules (deliberate):
 *  - argv-only, checked process-group establishment for mutations; read-only
 *    status retains execFileP and the existing sudoers path.
 *  - isRealDevice() gates EVERY op (G6). The helper itself runs as root; the
 *    backend must never invoke it in dev/emulated mode where there is no real
 *    sysext/systemd to drive. The gate fires BEFORE sudo is ever spawned.
 *  - The id is re-validated against the same charset the helper enforces, as
 *    defense in depth — a malformed id is rejected before it reaches argv.
 *  - Device, descriptor, read-only exec and owned mutation-step ports are explicit
 *    fixture inputs. Production never inherits the helper's test-tool overrides.
 */

import type { AddonDescriptor } from "@ceraui/rpc/schemas";
import { readAddonDescriptor } from "../modules/addons/descriptor-authority.ts";
import {
	getSysextActionDecision,
	runDisruptiveSysextStep,
} from "../modules/addons/disruptive-sysext-step.ts";
import { isRealDevice } from "../modules/system/device-detection.ts";
import { DisruptiveActionRefusedError } from "../modules/system/disruptive-action-error.ts";
import {
	type AddonHelperStep,
	createAddonHelperStep,
} from "./addon-helper-step.ts";
import { type ExecResult, execFileP } from "./exec.ts";

/** The privileged helper binary (resolved on PATH at /usr/bin on the device). */
const HELPER_BIN = "ceralive-addon-helper";
const SUDO = "sudo";

/**
 * Add-on id charset — mirrors `ADDON_ID_RE` in both the bash helper and
 * `packages/rpc/src/schemas/addons.schema.ts`. Lowercase alphanumeric with
 * internal hyphens; the charset forbids `/` and `.`, so it cannot express a
 * path or a leading-dash flag.
 */
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Returned by every wrapper call when the device gate is closed. The backend
 * surfaces this to the UI as a calm "unavailable in emulated mode" state rather
 * than an error (mirrors the kiosk `KIOSK_UNAVAILABLE_ERROR` convention).
 */
export const ADDON_UNAVAILABLE_ERROR = "addon_unavailable_in_emulated_mode";

/**
 * Explicit OS ports; mutation evidence is allocated before admission, never spawned then.
 */
export type AddonHelperDeps = {
	/** Whether we are on a real RK3588 device (G6 gate). */
	isRealDevice: () => Promise<boolean>;
	/** Run a binary argv-only (NO shell); rejects on non-zero exit. */
	exec: (file: string, args: readonly string[]) => Promise<ExecResult>;
	readDescriptor?: (id: string) => Promise<AddonDescriptor>;
	createStep?: (args: readonly string[]) => AddonHelperStep;
};

const defaultDeps: AddonHelperDeps = {
	isRealDevice: () => isRealDevice(),
	exec: (file, args) => execFileP(file, args),
};

/** Validate + return an add-on id, or throw before it can reach argv. */
function assertAddonId(id: string): string {
	if (!ADDON_ID_RE.test(id)) {
		throw new Error(`invalid add-on id: ${id}`);
	}
	return id;
}

/**
 * Gate on the real device, then invoke the helper argv-only. Returns
 * the helper's stdout (a JSON document the caller may parse). Throws
 * {@link ADDON_UNAVAILABLE_ERROR} when not on a real device, and rejects (via
 * the bounded runner) with the helper's stderr on a non-zero exit.
 */
async function invokeHelper(
	args: string[],
	deps: AddonHelperDeps,
): Promise<string> {
	if (!(await deps.isRealDevice())) {
		throw new Error(ADDON_UNAVAILABLE_ERROR);
	}
	if (args[0] !== "status") {
		const decision = await getSysextActionDecision();
		if (!decision.allowed)
			throw new DisruptiveActionRefusedError(decision.reason);
		const id = args[1];
		const descriptor =
			id === undefined
				? undefined
				: await (
						deps.readDescriptor ??
						((id: string) =>
							readAddonDescriptor(`/usr/share/ceralive/addons/${id}.json`))
					)(id);
		if (descriptor && descriptor.id !== id)
			throw new Error("add-on descriptor id mismatch");
		const units = descriptor
			? [
					...new Set([
						...(descriptor.units?.unmask ?? []),
						...(descriptor.units?.enable ?? []),
						...(descriptor.units?.start ?? []),
					]),
				]
			: [];
		const step = (deps.createStep ?? createAddonHelperStep)(args);
		const { stdout } = await runDisruptiveSysextStep(
			`helper:${args.join(":")}`,
			step.run,
			{ units, helper: step },
		);
		return stdout;
	}
	const { stdout } = await deps.exec(SUDO, [HELPER_BIN, ...args]);
	return stdout;
}

// All four are `async` so the synchronous assertAddonId() throw surfaces as a
// rejected promise (callers always await), never an unguarded sync throw.

/** Verify + activate the baked add-on `id` (helper re-checks sig + sha256). */
export async function addonEnable(
	id: string,
	deps: AddonHelperDeps = defaultDeps,
): Promise<string> {
	return invokeHelper(["enable", assertAddonId(id)], deps);
}

/** Tear down the add-on `id`: stop/mask units, remove the staged .raw, refresh. */
export async function addonDisable(
	id: string,
	deps: AddonHelperDeps = defaultDeps,
): Promise<string> {
	return invokeHelper(["disable", assertAddonId(id)], deps);
}

/** Run `systemd-sysext refresh` via the helper. */
export async function addonRefresh(
	deps: AddonHelperDeps = defaultDeps,
): Promise<string> {
	return invokeHelper(["refresh"], deps);
}

/** Read the baked registry + installed state as JSON via the helper. */
export async function addonStatus(
	deps: AddonHelperDeps = defaultDeps,
): Promise<string> {
	return invokeHelper(["status"], deps);
}
