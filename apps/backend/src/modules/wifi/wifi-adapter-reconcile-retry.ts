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
	legRelease?: () => Promise<boolean>;
	stationIntent?: () => void;
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

export function deferWifiStationIntent(owner: string, persist: () => void) {
	const state = recoveryFor(owner);
	const previous = state.stationIntent;
	state.stationIntent = persist;
	retryWifiAdapterReconcile(
		owner,
		"station preference not saved",
		"station-intent",
	);
	return () => {
		if (owners.get(owner)?.stationIntent !== persist) return;
		if (previous) state.stationIntent = previous;
		else clearDeferredWifiStationIntent(owner);
	};
}

export function clearDeferredWifiStationIntent(owner: string): void {
	const state = owners.get(owner);
	if (!state?.stationIntent) return;
	delete state.stationIntent;
	clearWifiAdapterReconcile(owner, "station-intent");
}

export function hasDeferredWifiStationIntent(owner: string): boolean {
	return owners.get(owner)?.stationIntent !== undefined;
}

/** Save the retry before a successful intent write clears it. */
export function snapshotDeferredWifiStationIntent(owner: string): () => void {
	const previous = owners.get(owner)?.stationIntent;
	return () => {
		if (previous && !hasDeferredWifiStationIntent(owner))
			deferWifiStationIntent(owner, previous);
	};
}

export function retryDeferredWifiStationIntent(owner: string): void {
	const persist = owners.get(owner)?.stationIntent;
	if (!persist) return;
	try {
		persist();
		clearDeferredWifiStationIntent(owner);
	} catch {
		retryWifiAdapterReconcile(owner, undefined, "station-intent");
	}
}

/** Captured-resource executors submit obligations under the existing owner lock. */
export function registerWifiAdapterTeardownLocked(
	owner: string,
	teardown: () => Promise<WifiPendingTeardownResult>,
): void {
	recoveryFor(owner).teardown = teardown;
	retryWifiAdapterReconcile(owner, "first-start cleanup pending", "cleanup");
}

export function registerWifiAdapterLegRelease(
	owner: string,
	release: () => Promise<boolean>,
): void {
	recoveryFor(owner).legRelease = release;
	retryWifiAdapterReconcile(
		owner,
		"borrowed AP leg not released",
		"leg-release",
	);
}

/** Start, Stop and discovery consume the same input under that same lock. */
export async function reconcileWifiAdapterTeardownLocked(
	owner: string,
): Promise<WifiPendingTeardownResult> {
	const state = owners.get(owner);
	const release = state?.legRelease;
	if (release && state) {
		const released = await release();
		if (state.legRelease === release) {
			if (released) {
				delete state.legRelease;
				clearWifiAdapterReconcile(owner, "leg-release");
			} else retryWifiAdapterReconcile(owner, undefined, "leg-release");
		}
	}
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
