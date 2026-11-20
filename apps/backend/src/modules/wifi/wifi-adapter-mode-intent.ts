import type { WifiAdapterMode } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import { isHotspotPortCredentialCopy } from "./hotspot-credentials.ts";
import { wifiAdapterKeyMac } from "./wifi-permanent-mac.ts";

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
	alias?: string,
): void {
	saveWifiAdapterModes({
		...(getConfig().wifi_modes ?? {}),
		[macAddress]: mode,
		...(alias ? { [alias]: mode } : {}),
	});
}

/** A newly seeded port inherits the existing intent without moving the plain record. */
export function seedWifiPortMode(
	owner: string,
	alias: string | undefined,
): void {
	if (!alias || alias === owner || !isHotspotPortCredentialCopy(alias)) return;
	const mode = getPersistedWifiAdapterMode(owner);
	if (mode === undefined || getPersistedWifiAdapterMode(alias) === mode) return;
	try {
		persistWifiAdapterMode(owner, mode, alias);
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
	alias?: { readonly key: string; readonly mode: WifiAdapterMode | undefined },
): void {
	const config = getConfig();
	const next = { ...(config.wifi_modes ?? {}) };
	if (previous === undefined) {
		delete next[macAddress];
	} else {
		next[macAddress] = previous;
	}
	if (alias) {
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
	if (address && preferences[address] !== undefined)
		return preferences[address] === "station" ? undefined : address;
	return keys.length === 1 ? keys[0] : undefined;
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

/** Undo only our own write; another authority may have superseded this intent. */
export function recordWifiAdapterModeIntent(
	key: string | undefined,
	target: WifiAdapterMode,
	recorder: WifiAdapterModeRecorder,
	portAlias?: string,
): () => void {
	if (key === undefined) return () => undefined;
	const previous = recorder.read(key);
	const alias =
		portAlias &&
		portAlias !== key &&
		(isHotspotPortCredentialCopy(portAlias) ||
			getPersistedWifiAdapterMode(portAlias) !== undefined)
			? { key: portAlias, mode: recorder.read(portAlias) }
			: undefined;
	if (alias) recorder.persist(key, target, alias.key);
	else recorder.persist(key, target);
	return () => {
		const undoAlias = alias && recorder.read(alias.key) === target;
		if (recorder.read(key) === target) {
			if (undoAlias) recorder.restore(key, previous, alias);
			else recorder.restore(key, previous);
		} else if (undoAlias) recorder.restore(alias.key, alias.mode);
	};
}
