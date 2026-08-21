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
 * The operator's per-modem data-usage policy (cycle day + advisory threshold).
 *
 * THE WRITE IS LOCAL, AND THAT IS A FINDING RATHER THAN A SHORTCUT. ModemManager
 * has no data-usage API at all — re-verified against the bench board's live
 * MM 1.24.2, where the only `Setup`/threshold surface on a real
 * `…/ModemManager1/Modem/N` is `Modem.Signal.Setup` / `Signal.SetupThresholds`,
 * whose keys are `rssi-threshold` and `error-rate-threshold` (radio quality, not
 * bytes). The only byte counters MM offers are the per-bearer read-only `Stats`,
 * which reset with every connection and so cannot carry a monthly cycle. So the
 * policy is durable local state, owned by `@ceralive/modem-control`'s
 * `setUsagePolicy` (a versioned, 0600, fail-soft file), which this module drives.
 *
 * IT IS IMPORTED STATICALLY. `setUsagePolicy` landed in
 * `@ceralive/modem-control@1.0.0`, so while `package.json` pinned the `0.2.0`
 * floor this module resolved it through a lazy `import()` plus a structural
 * probe and answered a typed `usage_policy_unsupported` refusal when the pinned
 * release did not publish it. The pin is now `1.1.0` EXACTLY, so that question
 * is settled at build time by `tsc` and at install time by `bun install` — both
 * strictly stronger than a runtime `typeof === "function"` check, which could
 * only report the gap after a write had already been attempted.
 *
 * THE CACHE EXISTS BECAUSE THE WIRE BUILD IS SYNCHRONOUS. `buildModemsWireMessage`
 * cannot await a file read, so this follows the `policy-route-check.ts` precedent
 * exactly: an async refresh writes a snapshot, and a sync getter serves it.
 */

import { join } from "node:path";

import {
	createUsagePolicyFileStore,
	type SetUsagePolicyResult,
	setUsagePolicy,
	type UsagePolicyStore,
} from "@ceralive/modem-control";

import { logger } from "../../helpers/logger.ts";

/** One modem's persisted policy. Both fields absent means "no policy set". */
export interface ModemUsagePolicy {
	readonly cycleDay?: number;
	readonly thresholdBytes?: number;
}

export type UsagePolicyWriteOutcome =
	| { readonly ok: true; readonly policy: ModemUsagePolicy }
	| { readonly ok: false; readonly reason: "usage_policy_write_failed" };

const DEFAULT_STORE_FILE = "modem-usage-policy.json";

function storePath(): string {
	const override = process.env.CERALIVE_MODEM_USAGE_POLICY_PATH;
	if (override !== undefined && override.length > 0) return override;
	// Beside `config.json` in the working directory, which is `/data`-persisted on
	// a real device — a policy that did not survive an OTA slot swap would silently
	// reset every operator's meter on update.
	return join(process.cwd(), DEFAULT_STORE_FILE);
}

let store: UsagePolicyStore | undefined;

/**
 * The store is built lazily rather than at module scope because
 * {@link storePath} reads the environment, which a test sets per case.
 */
function usagePolicyStore(): UsagePolicyStore {
	store ??= createUsagePolicyFileStore({ path: storePath() });
	return store;
}

let cache: ReadonlyMap<string, ModemUsagePolicy> = new Map();

/**
 * Whether this build can apply a usage-policy write.
 *
 * Constant, because the exact `1.1.0` pin makes it one. It stays a function
 * because `modem.data_usage_policy.supported` is an EXPLICIT wire field — the
 * modem merge preserves an omitted optional, so the claim must be published on
 * every row — and a single named answer is what keeps the wire and this module
 * from ever disagreeing about it.
 */
export function isUsagePolicySupported(): boolean {
	return true;
}

/** The cached policy for a slot key, or `undefined` when none is persisted. */
export function getCachedUsagePolicy(
	slotKey: string,
): ModemUsagePolicy | undefined {
	return cache.get(slotKey);
}

/**
 * The key a modem's policy is filed under.
 *
 * `stable_key` when the device has one, because a policy is a durable statement
 * about a piece of hardware and the legacy numeric id is a ModemManager index a
 * re-enumeration re-issues. A device with no ID_PATH falls back to the legacy id
 * — worse, but still stable within a boot, and the alternative is no policy at all.
 */
export function usagePolicySlotKey(
	legacyId: string,
	stableKey?: string,
): string {
	return stableKey !== undefined && stableKey.length > 0
		? `stable:${stableKey}`
		: `modem:${legacyId}`;
}

/** Re-read the persisted policies into the sync cache. Never throws. */
export async function refreshUsagePolicies(): Promise<void> {
	try {
		const state = await usagePolicyStore().load(Date.now());
		const next = new Map<string, ModemUsagePolicy>();
		for (const slot of state.slots) {
			next.set(slot.logicalSlotId, {
				...(slot.cycleDay !== undefined ? { cycleDay: slot.cycleDay } : {}),
				...(slot.thresholdBytes !== undefined
					? { thresholdBytes: slot.thresholdBytes }
					: {}),
			});
		}
		cache = next;
	} catch (error) {
		logger.warn("modem usage policy: refresh failed; retaining last snapshot", {
			error,
		});
	}
}

/**
 * Persist a policy change for one modem.
 *
 * Tri-state per field, forwarded verbatim to the package: `undefined` leaves the
 * persisted value alone, an explicit `null` clears it.
 */
export async function writeUsagePolicy(
	slotKey: string,
	change: {
		cycleDay?: number | null;
		thresholdBytes?: number | null;
	},
): Promise<UsagePolicyWriteOutcome> {
	let result: SetUsagePolicyResult;
	try {
		result = await setUsagePolicy(
			{ store: usagePolicyStore() },
			{
				logicalSlotId: slotKey,
				...(change.cycleDay !== undefined ? { cycleDay: change.cycleDay } : {}),
				...(change.thresholdBytes !== undefined
					? { thresholdBytes: change.thresholdBytes }
					: {}),
			},
		);
	} catch (error) {
		logger.warn("modem usage policy: write threw", { error });
		return { ok: false, reason: "usage_policy_write_failed" };
	}
	if (result.status !== "applied") {
		logger.warn("modem usage policy: write refused", {
			status: result.status,
			reason: result.reason,
		});
		return { ok: false, reason: "usage_policy_write_failed" };
	}
	const policy: ModemUsagePolicy = result.usage;
	const next = new Map(cache);
	if (policy.cycleDay === undefined && policy.thresholdBytes === undefined) {
		next.delete(slotKey);
	} else {
		next.set(slotKey, policy);
	}
	cache = next;
	return { ok: true, policy };
}

/** Test seam — drops the open store and the cache, so the next call re-reads. */
export function resetUsagePolicyState(): void {
	store = undefined;
	cache = new Map();
}
