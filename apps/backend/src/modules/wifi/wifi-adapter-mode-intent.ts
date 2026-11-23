import type { WifiAdapterMode } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import {
	getHotspotCredentialOwners,
	getHotspotCredentials,
	isHotspotPortCredentialCopy,
} from "./hotspot-credentials.ts";
import {
	clearDeferredWifiStationIntent,
	deferWifiStationIntent,
	hasDeferredWifiStationIntent,
	snapshotDeferredWifiStationIntent,
} from "./wifi-adapter-reconcile-retry.ts";
import {
	normalizeMacAddress,
	wifiAdapterKeyMac,
} from "./wifi-permanent-mac.ts";

// ─── persistence (permanent-MAC keyed) ───────────────────────────────────────

/**
 * The operator's stated mode for this adapter, or `undefined` when they have
 * never chosen. Absence is deliberately NOT `station`: the boot reconciler acts
 * on a stated preference only, so an untouched device keeps its behaviour.
 */
export function getPersistedWifiAdapterMode(
	macAddress: string | undefined,
): WifiAdapterMode | undefined {
	return macAddress === undefined
		? undefined
		: getConfig().wifi_modes?.[macAddress];
}

/** Every stated preference, keyed by permanent MAC. */
export function getPersistedWifiAdapterModes(): Readonly<
	Record<string, WifiAdapterMode>
> {
	return getConfig().wifi_modes ?? {};
}

/**
 * Record the operator's choice. Persisted BEFORE the radio is touched, on
 * `wifi-country.ts`'s terms: the persisted value is what the boot reconciler
 * re-applies, so a device that loses power mid-transition comes back trying for
 * the operator's mode rather than silently keeping the one it was leaving.
 */
export function persistWifiAdapterMode(
	macAddress: string,
	mode: WifiAdapterMode,
	aliases: readonly string[] = [],
): void {
	saveWifiAdapterModes({
		...(getConfig().wifi_modes ?? {}),
		[macAddress]: mode,
		...Object.fromEntries(aliases.map((alias) => [alias, mode])),
	});
	clearDeferredWifiStationIntent(macAddress);
}

/** A newly seeded port inherits the existing intent without moving the plain record. */
export function seedWifiPortMode(
	owner: string,
	alias: string | undefined,
): void {
	if (!alias || alias === owner || !isHotspotPortCredentialCopy(alias)) return;
	if (
		hasDeferredWifiStationIntent(owner) ||
		hasDeferredWifiStationIntent(alias)
	)
		return;
	const mode = getPersistedWifiAdapterMode(owner);
	if (mode === undefined || getPersistedWifiAdapterMode(alias) === mode) return;
	try {
		saveWifiAdapterModes({ ...getConfig().wifi_modes, [alias]: mode });
	} catch (error: unknown) {
		logger.warn("Could not persist the hotspot port intent", {
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** A failed atomic write must never publish an unpersisted intent to readers. */
function saveWifiAdapterModes(next: Record<string, WifiAdapterMode>): void {
	const config = getConfig();
	const previous = config.wifi_modes;
	config.wifi_modes = next;
	try {
		saveConfig();
	} catch (error: unknown) {
		config.wifi_modes = previous;
		throw error;
	}
}

/**
 * Restore a previous preference after a failed transition.
 *
 * `undefined` REMOVES the key rather than writing a value: an adapter that had
 * never been given a preference must not acquire one because a transition was
 * attempted and failed.
 */
export function restoreWifiAdapterMode(
	macAddress: string,
	previous: WifiAdapterMode | undefined,
	aliases: readonly ModeSnapshot[] = [],
): void {
	const config = getConfig();
	const next = { ...(config.wifi_modes ?? {}) };
	if (previous === undefined) {
		delete next[macAddress];
	} else {
		next[macAddress] = previous;
	}
	for (const alias of aliases) {
		if (alias.mode === undefined) delete next[alias.key];
		else next[alias.key] = alias.mode;
	}
	saveWifiAdapterModes(next);
}

/** One policy point for the logical intent identity, shared by Start, Stop and boot. */
export function resolveWifiAdapterModeIntentKey(
	macAddress: string,
	preferences = getPersistedWifiAdapterModes(),
	hotspotAdapterCount = 0,
): string | undefined {
	if (wifiAdapterKeyMac(macAddress)) return macAddress;
	if (hotspotAdapterCount !== 1) return undefined;
	const keys = Object.keys(preferences).filter(
		(key) => preferences[key] !== "station",
	);
	const addresses = new Set(keys.map((key) => key.split("@")[0]));
	if (addresses.size !== 1) return undefined;
	const address = keys[0]?.split("@")[0];
	return address && preferences[address] && preferences[address] !== "station"
		? address
		: undefined;
}

export interface WifiAdapterModeRecorder {
	readonly read: (key: string) => WifiAdapterMode | undefined;
	readonly persist: typeof persistWifiAdapterMode;
	readonly restore: typeof restoreWifiAdapterMode;
}

export const wifiAdapterModeRecorder: WifiAdapterModeRecorder = {
	read: getPersistedWifiAdapterMode,
	persist: persistWifiAdapterMode,
	restore: restoreWifiAdapterMode,
};

/** A durable preference is desirable, but cannot be a permit for Down. */
export function tryRecordWifiStationIntent(
	key: string | undefined,
	recorder: WifiAdapterModeRecorder,
	selectedPort?: string,
): (() => void) | undefined {
	if (key === undefined) return undefined;
	const logFailure = (error: unknown) => {
		logger.warn("Could not save the Wi-Fi station intent", {
			error: error instanceof Error ? error.name : "unknown",
		});
	};
	try {
		const undo = recordWifiAdapterModeIntent(
			key,
			"station",
			recorder,
			selectedPort,
		);
		return () => {
			try {
				undo();
			} catch (error: unknown) {
				logFailure(error);
			}
		};
	} catch (error: unknown) {
		logFailure(error);
		// A later choice can supersede one owner without resurrecting the others.
		const undo = [
			key,
			...modeAliases(key, "station", recorder, selectedPort),
		].map((owner) =>
			deferWifiStationIntent(owner, () => {
				if (
					owner === key ||
					owner === selectedPort ||
					isHotspotPortCredentialCopy(owner)
				)
					recorder.persist(owner, "station");
			}),
		);
		return () => {
			for (const cancel of undo) cancel();
		};
	}
}

type ModeSnapshot = {
	readonly key: string;
	readonly mode: WifiAdapterMode | undefined;
};

function modeAliases(
	key: string,
	target: WifiAdapterMode,
	recorder: WifiAdapterModeRecorder,
	selectedPort?: string,
) {
	const plain = normalizeMacAddress(key);
	const candidates =
		target === "station" && plain
			? getHotspotCredentialOwners().filter((alias) =>
					alias.startsWith(`${plain}@`),
				)
			: selectedPort && selectedPort !== key
				? [selectedPort]
				: [];
	return candidates.filter(
		(alias) =>
			isHotspotPortCredentialCopy(alias) ||
			(alias === selectedPort &&
				plain !== undefined &&
				alias.startsWith(`${plain}@`) &&
				Boolean(getHotspotCredentials(alias)?.conn) &&
				(target === "station" ||
					recorder.read(alias) === "station" ||
					hasDeferredWifiStationIntent(alias))),
	);
}

/** Undo only our own write; another authority may have superseded this intent. */
export function recordWifiAdapterModeIntent(
	key: string | undefined,
	target: WifiAdapterMode,
	recorder: WifiAdapterModeRecorder,
	/** MAC and literal port of the verified selected radio, not the profile owner. */
	selectedPort?: string,
): () => void {
	if (key === undefined) return () => undefined;
	const previous = recorder.read(key);
	const aliases = modeAliases(key, target, recorder, selectedPort);
	const snapshots: ModeSnapshot[] = aliases.map((alias) => ({
		key: alias,
		mode: recorder.read(alias),
	}));
	const deferred = new Map(
		[key, ...aliases].map((owner) => [
			owner,
			snapshotDeferredWifiStationIntent(owner),
		]),
	);
	const independent =
		selectedPort && !isHotspotPortCredentialCopy(selectedPort)
			? getHotspotCredentials(selectedPort)?.conn
			: undefined;
	// Recorder adapters observe the two-argument call when there are no copies.
	if (aliases.length) recorder.persist(key, target, aliases);
	else recorder.persist(key, target);
	for (const owner of deferred.keys()) clearDeferredWifiStationIntent(owner);
	return () => {
		const undoAliases = snapshots.filter(
			(alias) =>
				recorder.read(alias.key) === target &&
				(isHotspotPortCredentialCopy(alias.key) ||
					(alias.key === selectedPort &&
						independent !== undefined &&
						getHotspotCredentials(alias.key)?.conn === independent)),
		);
		const undoPrimary = recorder.read(key) === target;
		if (undoPrimary) deferred.get(key)?.();
		for (const alias of undoAliases) deferred.get(alias.key)?.();
		if (undoPrimary) {
			if (undoAliases.length) recorder.restore(key, previous, undoAliases);
			else recorder.restore(key, previous);
		} else {
			const [first, ...rest] = undoAliases;
			if (first) {
				if (rest.length) recorder.restore(first.key, first.mode, rest);
				else recorder.restore(first.key, first.mode);
			}
		}
	};
}
