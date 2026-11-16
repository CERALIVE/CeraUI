import { logger } from "../../helpers/logger.ts";
import { getms } from "../../helpers/time.ts";
import { clearBootDegraded, markBootDegraded } from "../system/readiness.ts";
import {
	clearWifiDiscoveryRetry,
	scheduleWifiDiscoveryRetry,
} from "./wifi-interfaces.ts";

const owners = new Map<string, { deadline: number; pending: Set<string> }>();

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
	let state = owners.get(owner);
	if (!state) {
		state = { deadline: getms() + 5 * 60 * 1000, pending: new Set() };
		owners.set(owner, state);
	}
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
