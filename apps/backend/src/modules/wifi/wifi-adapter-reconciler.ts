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
import {
	getWifiAdapterModeDiscoveryRevision,
	wifiHotspotLossVersion,
} from "./wifi-adapter-mode-events.ts";

import {
	beginWifiAdapterOwnerObservation,
	resolveWifiAdapterOwner,
} from "./wifi-adapter-owner.ts";
import {
	clearWifiAdapterReconcile,
	rearmWifiAdapterReconcile,
	reconcileWifiAdapterTeardownLocked,
	retryWifiAdapterReconcile,
	type WifiPendingTeardownResult,
} from "./wifi-adapter-reconcile-retry.ts";
import type {
	HotspotStopDeps,
	HotspotStopResult,
} from "./wifi-hotspot-config.ts";
import { runHotspotProfileOperation } from "./wifi-hotspot-profile-operation.ts";
import { applyHotspotProfilePolicy } from "./wifi-hotspot-profile-policy.ts";
import { teardownHotspotLocked } from "./wifi-hotspot-teardown.ts";
import {
	type HotspotActivationDeps,
	isHotspotActive,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";

export { retryWifiAdapterReconcile } from "./wifi-adapter-reconcile-retry.ts";

import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import { sameRadioLifetime, wifiRadioIdentity } from "./wifi-radio-identity.ts";

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
	teardown?: WifiPendingTeardownResult,
): Promise<boolean> {
	if (!normalizeMacAddress(owner.split("@")[0])) return true;
	if (!(teardown ?? (await reconcileWifiAdapterTeardownLocked(owner))).complete)
		return false;
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
): Promise<boolean> {
	if (!(await profile.write(profile.uuid, profile.fields)))
		return retryWifiAdapterReconcile(
			wifiAdapterLockKey(owner),
			`could not apply ${profile.uuid} policy`,
		);
	return true;
}

/** Stop reports actual teardown; policy failure remains recoverable owner health. */
export async function reconcileWifiAdapterStopLocked(
	registryKey: string,
	row: WifiInterfaceWithHotspot,
	deps: HotspotStopDeps,
): Promise<HotspotStopResult> {
	const owner = resolveWifiAdapterOwner(registryKey, row);
	const cleanup = await reconcileWifiAdapterTeardownLocked(owner);
	const conn = row.hotspot.conn;
	if (
		normalizeMacAddress(registryKey) &&
		row.degradedReason !== "permanent-mac-unresolved" &&
		(isHotspotActive(row) || row.hotspot.transition === "activating") &&
		conn &&
		!(
			await runHotspotProfileOperation({
				uuid: conn,
				kind: "modify",
				selected: true,
				fields: { "connection.autoconnect": "no" },
				run: (fields) => deps.nmConnSetFields(conn, fields),
			})
		).success
	)
		retryWifiAdapterReconcile(owner, `could not disable ${conn}`);
	const result = await teardownHotspotLocked(registryKey, row, deps, conn);
	await reconcileWifiAdapterLocked(
		owner,
		{
			identities: wifiRadioIdentity.state.rows,
			active: new Map(),
			station: true,
			write: deps.nmConnSetFields,
		},
		cleanup,
	);
	if (result.success && cleanup.stopped)
		clearWifiAdapterReconcile(owner, "restore");
	return cleanup.stopped
		? result
		: { success: false, error: "deactivation-failed" };
}

/** Physical recovery episodes share boot confirmation and the same owner retry state. */
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
	const identity = wifiRadioIdentity.state.rows.get(row.ifname);
	const observedLifetime =
		identity?.row === row ? identity.lifetime : undefined;
	const lifetime = observedLifetime ?? previous?.lifetime;
	const loss = wifiHotspotLossVersion(row);
	const active = observedWifiAdapterMode(row) !== "station";
	const lost =
		previous !== undefined &&
		((previous.row === row ? loss > previous.loss : loss > 0) ||
			(previous.completed && !active));
	const replaced =
		previous?.lifetime !== undefined &&
		observedLifetime !== undefined &&
		!sameRadioLifetime(previous.lifetime, observedLifetime);
	const newEpisode =
		previous !== undefined &&
		(previous.desired !== desired || lost || replaced);
	const recovering =
		newEpisode || (previous?.recovering ?? false) || (!previous && loss > 0);
	const edge: WifiRestoreEdge = {
		row,
		desired,
		signature,
		completed: false,
		attempts: newEpisode ? 0 : (previous?.attempts ?? 0),
		discovery: getWifiAdapterModeDiscoveryRevision(),
		loss,
		lifetime,
		recovering,
		...(!newEpisode && previous?.attempt ? { attempt: previous.attempt } : {}),
		...(!newEpisode && previous?.retryAfter !== undefined
			? { retryAfter: previous.retryAfter }
			: {}),
	};
	if (active) {
		cycle?.edges.set(owner, {
			...edge,
			completed: true,
			attempts: 0,
			recovering: false,
		});
		clearWifiAdapterReconcile(owner, "restore");
		return;
	}
	if (newEpisode) rearmWifiAdapterReconcile(owner);
	if (
		row.hotspot.transition ||
		row.removed ||
		(row.degradedReason && row.degradedReason !== "permanent-mac-unresolved") ||
		identity?.degradedReason === "unavailable"
	) {
		if (recovering) {
			cycle?.edges.set(owner, { ...edge, signature: "" });
			retryWifiAdapterReconcile(owner, undefined, "restore");
		}
		return;
	}
	if (edge.retryAfter !== undefined && getms() < edge.retryAfter) return;
	if (edge.attempts >= 3) {
		markBootDegraded(`wifi-hotspot-restore:${owner}`);
		return;
	}
	const same =
		previous?.signature === signature && previous.desired === desired;
	if (
		same &&
		!newEpisode &&
		(previous.discovery === edge.discovery || previous.attempts === 0)
	) {
		if (recovering && previous.discovery !== edge.discovery)
			retryWifiAdapterReconcile(owner, undefined, "restore");
		return;
	}
	const attempted = {
		...edge,
		attempts: edge.attempts + 1,
		attempt: {},
		recovering: true,
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
			recovering: !completed,
		});
		if (completed) clearWifiAdapterReconcile(owner, "restore");
		else if (current.attempts >= 3)
			markBootDegraded(`wifi-hotspot-restore:${owner}`);
		else retryWifiAdapterReconcile(owner, undefined, "restore");
	};
	let accepted = false;
	try {
		const result = await request.activate(settle);
		if (cycle?.stopped()) return;
		if (result === undefined) {
			cycle?.edges.set(owner, edge);
			if (recovering) retryWifiAdapterReconcile(owner, undefined, "restore");
			return;
		}
		if (!result.success && result.error === "DEVICE_BUSY") {
			cycle?.edges.set(owner, { ...edge, signature: "", recovering: true });
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
