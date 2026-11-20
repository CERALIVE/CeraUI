import { logger } from "../../helpers/logger.ts";
import { getms } from "../../helpers/time.ts";
import { clearBootDegraded, markBootDegraded } from "../system/readiness.ts";
import {
	clearWifiDiscoveryRetry,
	scheduleWifiDiscoveryRetry,
} from "./wifi-interfaces.ts";

export type WifiPendingTeardownResult = {
	readonly complete: boolean;
	readonly stopped: boolean;
};

type OwnerRecovery = {
	deadline: number;
	pending: Set<string>;
	teardown?: () => Promise<WifiPendingTeardownResult>;
};

const owners = new Map<string, OwnerRecovery>();

function recoveryFor(owner: string): OwnerRecovery {
	let state = owners.get(owner);
	if (!state) {
		state = { deadline: getms() + 5 * 60 * 1000, pending: new Set() };
		owners.set(owner, state);
	}
	return state;
}

/** Captured-resource executors submit obligations under the existing owner lock. */
export function registerWifiAdapterTeardownLocked(
	owner: string,
	teardown: () => Promise<WifiPendingTeardownResult>,
): void {
	recoveryFor(owner).teardown = teardown;
	retryWifiAdapterReconcile(owner, "first-start cleanup pending", "cleanup");
}

/** Start, Stop and discovery consume the same input under that same lock. */
export async function reconcileWifiAdapterTeardownLocked(
	owner: string,
): Promise<WifiPendingTeardownResult> {
	const state = owners.get(owner);
	if (!state?.teardown) return { complete: true, stopped: true };
	const result = await state.teardown();
	if (result.complete) {
		delete state.teardown;
		clearWifiAdapterReconcile(owner, "cleanup");
	} else {
		retryWifiAdapterReconcile(owner, "first-start cleanup pending", "cleanup");
	}
	return result;
}

/** One owner budget, using the existing coalesced discovery timer for all causes. */
export function retryWifiAdapterReconcile(
	owner: string,
	reason?: string,
	subsystem = "autoconnect",
): false {
	if (reason) {
		logger.error(`Wi-Fi hotspot ${subsystem} failed for ${owner}: ${reason}`);
		markBootDegraded(`wifi-hotspot-${subsystem}:${owner}`);
	}
	const state = recoveryFor(owner);
	state.pending.add(subsystem);
	if (getms() < state.deadline) scheduleWifiDiscoveryRetry();
	return false;
}

export function clearWifiAdapterReconcile(
	owner: string,
	subsystem: string,
): void {
	clearBootDegraded(`wifi-hotspot-${subsystem}:${owner}`);
	const state = owners.get(owner);
	state?.pending.delete(subsystem);
	if (state?.pending.size === 0) owners.delete(owner);
	if (owners.size === 0) clearWifiDiscoveryRetry();
}

/** A genuine loss or new incarnation gets a fresh bounded recovery window. */
export function rearmWifiAdapterReconcile(owner: string): void {
	const state = owners.get(owner);
	if (state) state.deadline = getms() + 5 * 60 * 1000;
}

/** Discovery termination and restart retire its retry budgets with its timers. */
export function cancelWifiAdapterReconciliation(): void {
	owners.clear();
}
