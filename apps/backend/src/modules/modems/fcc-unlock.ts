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

/**
 * The `fcc-auto-unlock` module — an OPT-IN POLICY surface, and nothing else.
 *
 * CeraUI runs no unlock procedure, ships no unlock script, and opens no AT
 * channel. All it does is record which `<vid>:<pid>` MODELS an operator opted in
 * for, into a file under `/data`; ModemManager's own dispatcher does the unlocking,
 * and `ceralive-fcc-reconcile` (shipped by `ceralive-modem-support`) re-derives the
 * admin-tier symlink from that file before ModemManager probes a radio on every
 * boot. Full model: `modem-stack/docs/FCC-UNLOCK-COVERAGE.md`.
 *
 * Four rules carry it:
 *
 * 1. THE POLICY LIVES IN `/data`, NOT IN `/etc`. The mechanism is a symlink in
 *    `/etc/ModemManager/fcc-unlock.d/`, and `/etc` rides the rootfs — exactly what
 *    a RAUC A/B slot swap REPLACES. An opt-in recorded only as a symlink survives
 *    a reboot and NOT an OTA, so the file is the record and the symlink is derived.
 *
 * 2. THE COVERAGE CHECK IS PART OF THE WRITE. Persisting `true` for a model
 *    ModemManager ships no procedure for leaves an enabled toggle that provably
 *    cannot act — the reconciler skips it forever, silently. Refusing at the write
 *    is the only place that fact reaches the person who asked for it. DISABLING is
 *    deliberately never coverage-checked: a fail-closed opt-OUT is not a thing.
 *
 * 3. IT ROUTES THROUGH `withCapabilityModuleMutation`, never around it. An FCC
 *    unlock re-registers the radio and can cost the bond link, so `fcc-auto-unlock`
 *    is a JOURNALED module and the type system will not let this dispatch without
 *    a `preState`.
 *
 * 4. ENABLING IS NOT RETROACTIVE. ModemManager runs the dispatcher during modem
 *    INITIALIZATION, so an already-enumerated modem needs a re-probe
 *    (`--disable` then `--enable`). That drops the bearer, so it is spent ONLY on
 *    a write that genuinely changed the persisted answer.
 */

import type {
	CapabilityEvidence,
	FccUnlockOptionsOutput,
	FccUnlockState,
	SetFccUnlockOutput,
} from "@ceraui/rpc/schemas";
import {
	normalizeFccUnlockKey,
	resolveFccUnlockCoverage,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { getUsbPhysicalDescriptor } from "../network/router-cellular-scan.ts";

import {
	type CapabilityMutationResult,
	withCapabilityModuleMutation,
} from "./capability-mutation.ts";
import {
	FCC_UNLOCK_POLICY_PATH,
	loadFccUnlockPolicy,
	saveFccUnlockPolicy,
} from "./fcc-unlock-store.ts";
import { mmReprobeModem } from "./mmcli.ts";
import { broadcastModems } from "./modem-status.ts";
import { getModem } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { registerMutationRollback } from "./mutation-rollback.ts";

/**
 * `device` is the same selector every other modem procedure takes: a bare
 * ModemManager index ("2") or a full object path. Anything else resolves to
 * `undefined` and is refused, rather than coerced to `NaN` and dispatched.
 */
function resolveModemIndex(device: string): number | undefined {
	const trailing =
		/^(?:\/org\/freedesktop\/ModemManager1\/Modem\/)?(\d+)$/.exec(
			device.trim(),
		);
	return trailing === null ? undefined : Number(trailing[1]);
}

/**
 * The dispatcher key behind a modem, read from its parent USB device's
 * descriptors — the SAME sysfs sweep the classifier and the identity resolver use,
 * so a row an operator is looking at and a key this module writes cannot describe
 * different hardware. `undefined` means the ids could not be read.
 */
export function fccUnlockKeyForIfname(
	ifname: string | undefined,
): string | undefined {
	if (ifname === undefined) return undefined;
	const descriptor = getUsbPhysicalDescriptor(ifname);
	return normalizeFccUnlockKey(descriptor?.vid, descriptor?.pid);
}

/**
 * The `fcc-auto-unlock` capability probe.
 *
 * `capability/detect.ts` answers `unknown` for this module on the modem's own
 * D-Bus surface, and says why: FCC unlock is carried out by a ModemManager
 * DISPATCHER keyed on the device, so nothing the modem itself reports says whether
 * a procedure applies. The evidence therefore comes from the CATALOG, which is
 * what this reads.
 */
export function fccUnlockEvidence(
	ifname: string | undefined,
): CapabilityEvidence {
	if (ifname === undefined) return "unknown";
	const descriptor = getUsbPhysicalDescriptor(ifname);
	return resolveFccUnlockCoverage(descriptor?.vid, descriptor?.pid);
}

export type FccUnlockDeps = {
	readonly loadPolicy: () => Promise<Record<string, boolean>>;
	readonly savePolicy: (unlock: Record<string, boolean>) => Promise<void>;
	/** The re-probe an already-enumerated modem needs. Resolves false on refusal. */
	readonly reprobe: (id: number) => Promise<boolean>;
	readonly broadcast: (id: number) => void;
};

export const defaultFccUnlockDeps: FccUnlockDeps = {
	loadPolicy: loadFccUnlockPolicy,
	savePolicy: saveFccUnlockPolicy,
	reprobe: mmReprobeModem,
	broadcast: (id) => broadcastModems({ [id]: true }),
};

let activeDeps: FccUnlockDeps = defaultFccUnlockDeps;

export function setFccUnlockDeps(deps: Partial<FccUnlockDeps>): void {
	activeDeps = { ...defaultFccUnlockDeps, ...deps };
}

export function resetFccUnlockDeps(): void {
	activeDeps = defaultFccUnlockDeps;
}

function buildState(
	key: string | undefined,
	coverage: FccUnlockState["coverage"],
	enabled: boolean,
): FccUnlockState {
	return {
		...(key === undefined ? {} : { key }),
		coverage,
		enabled,
		model_wide: true,
		requires_reprobe: true,
	};
}

/** The pure READ a dialog opens on. Takes no lease and writes nothing. */
export async function readFccUnlockState(
	device: string,
	deps: FccUnlockDeps = activeDeps,
): Promise<FccUnlockOptionsOutput> {
	const id = resolveModemIndex(device);
	const modem = id === undefined ? undefined : getModem(id);
	if (id === undefined || modem === undefined) {
		return { success: false, error: "unknown_modem" };
	}

	const key = fccUnlockKeyForIfname(modem.ifname);
	const coverage = fccUnlockEvidence(modem.ifname);
	const unlock = await deps.loadPolicy();
	return {
		success: true,
		state: buildState(key, coverage, key !== undefined && unlock[key] === true),
	};
}

export async function setFccUnlockEnabled(
	device: string,
	enabled: boolean,
	deps: FccUnlockDeps = activeDeps,
): Promise<SetFccUnlockOutput> {
	const id = resolveModemIndex(device);
	const modem = id === undefined ? undefined : getModem(id);
	if (id === undefined || modem === undefined) {
		return { success: false, error: "unknown_modem" };
	}

	// Both checks run on PURE reads, before a lease is taken and before anything
	// is journaled — the same ordering the USB-mode catalog check follows. A write
	// that is doomed whatever the device's lease state must not contend for it.
	const key = fccUnlockKeyForIfname(modem.ifname);
	if (key === undefined) {
		return { success: false, error: "identity_unknown" };
	}
	const coverage = fccUnlockEvidence(modem.ifname);
	if (enabled && coverage !== "present") {
		return { success: false, error: "not_covered" };
	}

	const before = await deps.loadPolicy();
	const wasEnabled = before[key] === true;

	const outcome = await withCapabilityModuleMutation(
		{
			module: "fcc-auto-unlock",
			stableKey: modemStableKeyForId(id),
			// The pre-state is this MODEL's own previous answer, so a rollback
			// restores what the operator had rather than a blanket "off".
			preState: { key, enabled: wasEnabled },
		},
		async ({
			journal,
		}): Promise<CapabilityMutationResult<SetFccUnlockOutput>> => {
			await journal?.markExecuting();
			try {
				await deps.savePolicy({ ...before, [key]: enabled });
			} catch (err) {
				logger.error(`fcc-unlock: could not write ${FCC_UNLOCK_POLICY_PATH}`, {
					module: "modems",
					err,
				});
				return {
					confirmed: false,
					value: { success: false, error: "write_failed" } as const,
					detail: `policy write failed for ${key}`,
				};
			}

			// A no-op write must not cost the operator their bearer.
			const reprobed = wasEnabled === enabled ? false : await deps.reprobe(id);
			return {
				confirmed: true,
				value: {
					success: true,
					state: buildState(key, coverage, enabled),
					reprobed,
				} as const,
			};
		},
	);

	deps.broadcast(id);

	if (!outcome.ok) {
		return { success: false, refusal: outcome.refusal };
	}
	return outcome.value;
}

/**
 * Put the policy back on its journaled pre-state.
 *
 * There is nothing to prove on the DEVICE here — the mutation was a file write,
 * and the symlink it governs is re-derived at boot — so a restore is `restored`
 * once the file says what it said before. A pre-state with no key answers `failed`
 * rather than silently doing nothing: the device was journaled without the one
 * value a restore needs, and claiming otherwise is what a fail-closed rollback
 * must never do.
 */
export function createFccUnlockRollbackHandler(
	deps: FccUnlockDeps = activeDeps,
) {
	return {
		async rollback(
			_stableKey: string,
			preState: Readonly<Record<string, unknown>>,
		): Promise<"restored" | "failed"> {
			const key = preState.key;
			const enabled = preState.enabled;
			if (typeof key !== "string" || typeof enabled !== "boolean") {
				return "failed";
			}
			try {
				const current = await deps.loadPolicy();
				await deps.savePolicy({ ...current, [key]: enabled });
				return "restored";
			} catch {
				return "failed";
			}
		},
	};
}

export function initFccUnlockModule(): void {
	registerMutationRollback("fcc-unlock", createFccUnlockRollbackHandler());
}
