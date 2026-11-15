// allow: SIZE_OK - one logical-owner state machine keeps policy and recovery decisions together; inputs and executors are separate.
import type {
	WifiModeReconcileRequest,
	WifiPolicyObservation,
	WifiRestoreEdge,
	WifiRestoreRequest,
} from "./wifi-adapter-reconcile-types.ts";

export type {
	WifiModeReconcileRequest,
	WifiPolicyObservation,
	WifiRestoreCycle,
	WifiRestoreEdge,
	WifiRestoreRequest,
} from "./wifi-adapter-reconcile-types.ts";

import type { SetWifiAdapterModeOutput } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { getms } from "../../helpers/time.ts";
import { markBootDegraded } from "../system/readiness.ts";
import { getHotspotCredentialOwners } from "./hotspot-credentials.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import { observedWifiAdapterMode } from "./wifi-adapter-mode.ts";
import { getWifiAdapterModeDiscoveryRevision } from "./wifi-adapter-mode-events.ts";

import {
	beginWifiAdapterOwnerObservation,
	resolveWifiAdapterOwner,
} from "./wifi-adapter-owner.ts";
import {
	clearWifiAdapterReconcile,
	retryWifiAdapterReconcile,
} from "./wifi-adapter-reconcile-retry.ts";
import type {
	HotspotStopDeps,
	HotspotStopResult,
} from "./wifi-hotspot-config.ts";
import { applyHotspotProfilePolicy } from "./wifi-hotspot-profile-policy.ts";
import { teardownHotspotLocked } from "./wifi-hotspot-teardown.ts";
import {
	type HotspotActivationDeps,
	isHotspotActive,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";

export { retryWifiAdapterReconcile } from "./wifi-adapter-reconcile-retry.ts";

import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import { wifiRadioIdentity } from "./wifi-radio-identity.ts";

/**
 * The caller holds the logical owner's lock. Every owned profile participates
 * in the pass; health clears only after the entire owner has converged.
 */
export async function reconcileWifiAdapterLocked(
	owner: string,
	observation: WifiPolicyObservation = {
		identities: wifiRadioIdentity.state.rows,
		active: new Map(),
	},
): Promise<boolean> {
	if (!normalizeMacAddress(owner.split("@")[0])) return true;
	const applied = await applyHotspotProfilePolicy(owner, observation);
	if (!applied.success)
		return retryWifiAdapterReconcile(owner, undefined, "discovery");
	const failure = applied.result;
	if (failure) return retryWifiAdapterReconcile(owner, failure);
	clearWifiAdapterReconcile(owner, "autoconnect");
	return true;
}

/** Discovery, identity retries and boot all enter through this owner pass. */
export async function reconcileWifiAdapterPolicies(
	observation: WifiPolicyObservation,
): Promise<boolean> {
	beginWifiAdapterOwnerObservation();
	for (const owner of getHotspotCredentialOwners()) {
		const result = await withWifiAdapterLock(wifiAdapterLockKey(owner), () =>
			reconcileWifiAdapterLocked(owner, observation),
		);
		if (!result.success)
			return retryWifiAdapterReconcile(owner, undefined, "discovery");
		if (!result.result) return false;
	}
	return true;
}

export async function reconcileWifiAdapterProfileLocked(
	owner: string,
	profile: {
		readonly uuid: string;
		readonly fields: Record<string, string>;
		readonly write: HotspotActivationDeps["nmConnSetFields"];
	},
): Promise<void> {
	if (!(await profile.write(profile.uuid, profile.fields)))
		retryWifiAdapterReconcile(
			wifiAdapterLockKey(owner),
			`could not apply ${profile.uuid} policy`,
		);
}

/** Stop reports actual teardown; policy failure remains recoverable owner health. */
export async function reconcileWifiAdapterStopLocked(
	registryKey: string,
	row: WifiInterfaceWithHotspot,
	deps: HotspotStopDeps,
): Promise<HotspotStopResult> {
	const owner = resolveWifiAdapterOwner(registryKey, row);
	const conn = row.hotspot.conn;
	if (
		normalizeMacAddress(registryKey) &&
		row.degradedReason !== "permanent-mac-unresolved" &&
		(isHotspotActive(row) || row.hotspot.transition === "activating") &&
		conn &&
		!(await deps.nmConnSetFields(conn, {
			"connection.autoconnect": "no",
		}))
	)
		retryWifiAdapterReconcile(owner, `could not disable ${conn}`);
	const result = await teardownHotspotLocked(registryKey, row, deps, conn);
	await reconcileWifiAdapterLocked(owner, {
		identities: wifiRadioIdentity.state.rows,
		active: new Map(),
		station: true,
		write: deps.nmConnSetFields,
	});
	if (result.success) clearWifiAdapterReconcile(owner, "restore");
	return result;
}

/** Boot and runtime restore share the same owner, checked executor and retry timer. */
export async function reconcileWifiAdapterRestoreLocked(
	owner: string,
	request: WifiRestoreRequest,
): Promise<void> {
	const { row, desired, signature, cycle } = request;
	if (cycle?.stopped()) return;
	if (
		desired === "station" ||
		(desired === undefined && row.degradedReason !== "permanent-mac-unresolved")
	) {
		cycle?.edges.delete(owner);
		clearWifiAdapterReconcile(owner, "restore");
		return;
	}
	const previous = cycle?.edges.get(owner);
	if (observedWifiAdapterMode(row) !== "station") {
		cycle?.edges.set(owner, {
			row,
			desired,
			signature,
			completed: true,
			attempts: 0,
			discovery: getWifiAdapterModeDiscoveryRevision(),
		});
		clearWifiAdapterReconcile(owner, "restore");
		return;
	}
	if (
		previous?.row === row &&
		previous.completed &&
		previous.desired === desired
	)
		return;
	const discovery = getWifiAdapterModeDiscoveryRevision();
	if (
		previous?.row === row &&
		previous.desired === desired &&
		previous.retryAfter !== undefined &&
		getms() < previous.retryAfter
	)
		return;
	if (
		previous?.row === row &&
		previous.desired === desired &&
		previous.attempts >= 3
	) {
		markBootDegraded(`wifi-hotspot-restore:${owner}`);
		return;
	}
	const same = previous?.row === row && previous.signature === signature;
	if (
		same &&
		(previous.attempts === 0 ||
			previous.discovery === discovery ||
			(previous.attempts ?? 0) >= 3)
	)
		return;
	const edge: WifiRestoreEdge = {
		row,
		desired,
		signature,
		completed: false,
		attempts:
			previous?.row === row && previous.desired === desired
				? previous.attempts
				: 0,
		discovery,
	};
	const attempted = {
		...edge,
		attempts: (edge.attempts ?? 0) + 1,
		attempt: {},
	};
	cycle?.edges.set(owner, attempted);
	const settle = (confirmed: boolean): void => {
		if (cycle?.stopped()) return;
		const current = cycle ? cycle.edges.get(owner) : attempted;
		if (
			!current ||
			current.attempt !== attempted.attempt ||
			(request.isCurrent && !request.isCurrent())
		)
			return;
		const completed = confirmed && observedWifiAdapterMode(row) !== "station";
		cycle?.edges.set(owner, {
			...current,
			completed,
			attempts: completed ? 0 : current.attempts,
		});
		if (completed) clearWifiAdapterReconcile(owner, "restore");
		else if ((current.attempts ?? 0) >= 3)
			markBootDegraded(`wifi-hotspot-restore:${owner}`);
		else retryWifiAdapterReconcile(owner, undefined, "restore");
	};
	let accepted = false;
	try {
		const result = await request.activate(settle);
		if (cycle?.stopped()) return;
		if (result === undefined) {
			cycle?.edges.set(owner, edge);
			return;
		}
		if (!result.success && result.error === "DEVICE_BUSY") {
			cycle?.edges.set(owner, { ...edge, signature: "" });
			retryWifiAdapterReconcile(owner, undefined, "restore");
			return;
		}
		accepted = result.success;
		if (result.success && observedWifiAdapterMode(row) === "station") {
			cycle?.edges.set(owner, { ...attempted, retryAfter: getms() + 3000 });
			retryWifiAdapterReconcile(owner, undefined, "restore");
			return;
		}
	} catch (error: unknown) {
		logger.error(
			`wifi mode restore failed for ${owner}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	settle(accepted);
}

/** Explicit mode callers record intent, then request convergence under its owner lock. */
export async function reconcileWifiAdapterModeLocked(
	owner: string,
	request: WifiModeReconcileRequest,
): Promise<SetWifiAdapterModeOutput> {
	const { row, target, publish } = request;
	if (
		target === "station" &&
		!(await reconcileWifiAdapterLocked(owner, {
			identities: wifiRadioIdentity.state.rows,
			active: new Map(),
			station: true,
		}))
	) {
		const result = { success: false, error: "deactivation-failed" } as const;
		publish(row.id, result);
		return result;
	}
	const current = observedWifiAdapterMode(row);
	if (current === target) {
		publish(row.id, { success: true, mode: target });
		return { success: true, applied: target };
	}
	request.publishPending();
	if (current !== "station") {
		const stopped = await request.stop(target === "station");
		if (!stopped.success) {
			if (target !== "station") publish(row.id, stopped);
			return stopped;
		}
		if (target === "station") return { success: true, applied: target };
	}
	const started = await request.start();
	return started.success
		? { success: true, accepted: true, applied: target }
		: started;
}
