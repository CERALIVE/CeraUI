// allow: SIZE_OK - the versioned ownership store keeps migration, collision checks and atomic credential/creation updates together.
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
  Durable per-adapter hotspot identity.

  NetworkManager's own `.nmconnection` files are the primary source of truth for
  a hotspot profile and are already persistent — this store does NOT replace
  them. It is the BACKSTOP for the one thing NetworkManager cannot provide: if
  the profile is deleted out from under CeraUI (an operator `nmcli con del`, a
  `/etc/NetworkManager/system-connections` wipe, an image re-flash that keeps
  `/data`), the SSID and password the operator's phone already knows are gone
  forever and the next hotspot start would mint a brand-new pair.

  Keyed by the adapter's PERMANENT hardware address (see `wifi-permanent-mac.ts`)
  so a device with several radios keeps one independent identity per radio, and
  so the key survives NetworkManager's scan-time MAC randomization.

  Follows the codebase's atomic-JSON convention (`docs/CONFIG_PERSISTENCE.md`):
  whole-file replace through `writeFileAtomicSync` (temp → fsync → rename). No
  database — that decision is recorded in the same document.
*/

import { z } from "zod";

import {
	loadCacheFile,
	writeFileAtomicSync,
} from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import type { NmProfileInstance } from "../network/network-manager-profile-instance.ts";
import { isWifiChannelName, type WifiChannel } from "./wifi-channels.ts";
import { normalizeWifiAdapterKey } from "./wifi-permanent-mac.ts";

/** Default on-disk location, relative to the backend's working directory. */
export const HOTSPOT_CREDENTIALS_FILE = "hotspot_credentials.json";

/**
 * How many retired UUIDs an adapter remembers. Bounded because a profile that
 * is recreated on every start would otherwise grow the file without limit; 8 is
 * far beyond the duplicate counts ever observed on a real device (six).
 */
export const PREVIOUS_CONNS_LIMIT = 8;

/**
 * Written on every save. Version 1 files carry no `previousConns`; they load
 * unchanged and gain an empty history (see {@link migrateEntry}).
 */
const STORE_VERSION = 2;

/** The identity of one adapter's hotspot, reused for the life of the adapter. */
export type HotspotCredentials = {
	/** Broadcast SSID. Stable once generated. */
	ssid: string;
	/** WPA2 pre-shared key. Stable once generated. */
	password: string;
	/**
	 * Last known NetworkManager connection UUID. A HINT only — it is re-verified
	 * against NetworkManager before use, and a hotspot is recreated from `ssid` +
	 * `password` when the profile behind it is gone.
	 */
	conn?: string;
	/** Last configured channel selection. */
	channel?: WifiChannel;
	/**
	 * UUIDs this adapter previously carried as `conn`, oldest first. This is the
	 * ONLY record that a superseded profile was ever ours, and profile cleanup
	 * refuses to delete anything it cannot find here (`wifi-hotspot-discovery.ts`
	 * `collectSupersededHotspotConns`).
	 *
	 * READ-ONLY: the store maintains it whenever `conn` is replaced. A value
	 * passed to {@link rememberHotspotCredentials} is ignored.
	 */
	previousConns?: readonly string[];
};

const entrySchema = z.object({
	ssid: z.string().min(1),
	password: z.string().min(1),
	conn: z.string().min(1).optional(),
	channel: z.string().min(1).optional(),
	previousConns: z.array(z.string().min(1)).optional(),
	pendingCreation: z.string().min(1).optional(),
	pendingCreationInstance: z
		.object({
			path: z.string().min(1),
			fingerprint: z.string().min(1),
			runId: z.string().min(1).optional(),
			file: z
				.object({
					filename: z.string().min(1),
					device: z.string().min(1),
					inode: z.string().min(1),
					ctime: z.string().min(1),
				})
				.optional(),
		})
		.optional(),
	updatedAt: z.number().optional(),
});

const fileSchema = z.object({
	version: z.union([z.literal(1), z.literal(2)]).optional(),
	adapters: z.record(z.string(), entrySchema).optional(),
});

/** Port copies have no update timestamp or UUID evidence; empty released history is allowed. */
type StoredEntry = z.infer<typeof entrySchema>;

let filePath = HOTSPOT_CREDENTIALS_FILE;
let entries: Record<string, StoredEntry> = {};
/**
 * Writes are inert until `initHotspotCredentials()` runs. Production calls it
 * once at boot; a unit test that never opts in therefore gets a pure in-memory
 * store and cannot litter the working directory.
 */
let initialized = false;

function keyFor(macAddress: string): string | undefined {
	return normalizeWifiAdapterKey(macAddress);
}

function toCredentials(entry: StoredEntry): HotspotCredentials {
	return {
		ssid: entry.ssid,
		password: entry.password,
		...(entry.conn !== undefined ? { conn: entry.conn } : {}),
		...(entry.channel !== undefined && isWifiChannelName(entry.channel)
			? { channel: entry.channel }
			: {}),
		previousConns: entry.previousConns ?? [],
	};
}

/** Bound recorded history without adding ownership fields to credential copies. */
function migrateEntry(entry: StoredEntry): StoredEntry {
	return entry.previousConns === undefined
		? entry
		: { ...entry, previousConns: boundHistory(entry.previousConns) };
}

/** Newest-last, de-duplicated, capped at {@link PREVIOUS_CONNS_LIMIT}. */
function boundHistory(history: readonly string[]): string[] {
	return [...new Set(history)].slice(-PREVIOUS_CONNS_LIMIT);
}

/**
 * The history an entry carries after this write. A uuid is recorded ONLY when a
 * real replacement retires it — one known uuid giving way to a different known
 * one. Anything else leaves the history untouched, so the failure direction is
 * forgetting evidence (which makes a profile unknown, hence undeletable) rather
 * than inventing it.
 */
function nextHistory(
	previous: StoredEntry | undefined,
	nextConn: string | undefined,
): string[] {
	const history = previous?.previousConns ?? [];
	const retired = previous?.conn;
	if (!retired || !nextConn || retired === nextConn) {
		return boundHistory(history);
	}
	return boundHistory([...history.filter((uuid) => uuid !== retired), retired]);
}

function persist(): void {
	if (!initialized) return;
	try {
		writeFileAtomicSync(
			filePath,
			JSON.stringify({ version: STORE_VERSION, adapters: entries }),
		);
	} catch (err) {
		// A hotspot must never fail to start because its credential backstop could
		// not be written — NetworkManager still holds the profile.
		logger.warn(`Failed to persist hotspot credentials: ${err}`);
	}
}

/**
 * Load the store from disk and arm persistence. Never throws: a missing or
 * corrupt file starts an empty store (the NetworkManager profile remains the
 * primary source of truth, so nothing is lost that cannot be re-adopted).
 */
export async function initHotspotCredentials(
	path: string = HOTSPOT_CREDENTIALS_FILE,
): Promise<void> {
	filePath = path;
	const data = await loadCacheFile(path, fileSchema, {});
	entries = Object.fromEntries(
		Object.entries(data.adapters ?? {}).map(([key, entry]) => [
			key,
			migrateEntry(entry),
		]),
	);
	initialized = true;
	const count = Object.keys(entries).length;
	if (count > 0) {
		logger.debug(`Loaded hotspot credentials for ${count} adapter(s)`);
	}
}

/** The persisted hotspot identity for an adapter's permanent MAC, if any. */
export function getHotspotCredentials(
	macAddress: string,
): HotspotCredentials | undefined {
	const key = keyFor(macAddress);
	if (!key) return undefined;
	const entry = entries[key];
	return entry ? toCredentials(entry) : undefined;
}

/** Every adapter's persisted identity — the ownership evidence profile cleanup reads. */
export function getAllHotspotCredentials(): HotspotCredentials[] {
	return Object.values(entries).map(toCredentials);
}

/** All persisted keys, or the keys that positively own a current/retired UUID. */
export function getHotspotCredentialOwners(uuid?: string): string[] {
	return Object.entries(entries)
		.filter(
			([, entry]) =>
				uuid === undefined ||
				entry.conn === uuid ||
				entry.pendingCreation === uuid ||
				entry.previousConns?.includes(uuid),
		)
		.map(([key]) => key);
}

/** A prepared copy does not grant ownership of a NetworkManager profile. */
export function isHotspotPortCredentialCopy(key: string): boolean {
	const entry = entries[normalizeWifiAdapterKey(key)];
	return (
		key.includes("@") &&
		entry !== undefined &&
		entry.updatedAt === undefined &&
		!entry.conn &&
		!entry.pendingCreation &&
		!entry.pendingCreationInstance &&
		!entry.previousConns?.length
	);
}

/** A successful NM inventory proved this retired UUID no longer exists. */
export function pruneAbsentHotspotHistory(owner: string, uuid: string): void {
	const entry = entries[keyFor(owner) ?? ""];
	if (!entry?.previousConns?.includes(uuid)) return;
	entry.previousConns = entry.previousConns.filter(
		(previous) => previous !== uuid,
	);
	persist();
}

/** Absent adapters and retired UUIDs retain their ownership evidence. */
export function canUseHotspotConnection(
	macAddress: string,
	uuid: string | undefined,
): boolean {
	if (!uuid) return true;
	const key = keyFor(macAddress);
	return !Object.entries(entries).some(
		([owner, entry]) =>
			keyFor(owner) !== key &&
			(entry.conn === uuid ||
				entry.pendingCreation === uuid ||
				entry.previousConns?.includes(uuid)),
	);
}

/**
 * Record (or update) an adapter's hotspot identity. Writes only on a real
 * change, so the routine re-assertions made on every hotspot start cost no I/O.
 * A replaced `conn` is retired into `previousConns`; a caller-supplied history
 * is ignored.
 */
export function rememberHotspotCredentials(
	macAddress: string,
	credentials: HotspotCredentials,
	portAlias?: string,
): void {
	const key = keyFor(macAddress);
	if (!key || !credentials.ssid || !credentials.password) return;
	if (!canUseHotspotConnection(macAddress, credentials.conn)) return;

	const previous = entries[key];
	// A suggestion must not erase evidence of an already contaminated UUID.
	if (
		!credentials.conn &&
		!canUseHotspotConnection(macAddress, previous?.conn)
	) {
		return;
	}
	const next: StoredEntry = {
		ssid: credentials.ssid,
		password: credentials.password,
		...(credentials.conn !== undefined ? { conn: credentials.conn } : {}),
		...(credentials.channel !== undefined
			? { channel: credentials.channel }
			: {}),
		previousConns: nextHistory(previous, credentials.conn),
		...(previous?.pendingCreation
			? { pendingCreation: previous.pendingCreation }
			: {}),
		...(previous?.pendingCreationInstance
			? { pendingCreationInstance: previous.pendingCreationInstance }
			: {}),
		updatedAt: Date.now(),
	};

	const same =
		previous &&
		previous.ssid === next.ssid &&
		previous.password === next.password &&
		previous.conn === next.conn &&
		previous.channel === next.channel;
	let mirrored = false;
	if (portAlias?.startsWith(`${key}@`) && !key.includes("@")) {
		const alias = entries[portAlias];
		if (
			(!alias || isHotspotPortCredentialCopy(portAlias)) &&
			(alias?.ssid !== next.ssid ||
				alias.password !== next.password ||
				alias.channel !== next.channel)
		) {
			entries[portAlias] = {
				ssid: next.ssid,
				password: next.password,
				...(next.channel !== undefined ? { channel: next.channel } : {}),
			};
			mirrored = true;
		}
	}
	if (!same) entries[key] = next;
	if (!same || mirrored) persist();
}

/** Stage before add, then bind the returned settings instance; never ordinary adoption. */
export function recordHotspotProfileCreation(
	owner: string,
	uuid: string,
	instance?: NmProfileInstance,
): boolean {
	const key = keyFor(owner);
	const entry = key && entries[key];
	if (
		!key ||
		!entry ||
		!canUseHotspotConnection(owner, uuid) ||
		(entry.pendingCreation && entry.pendingCreation !== uuid)
	)
		return false;
	const next = {
		...entries,
		[key]: {
			...entry,
			pendingCreation: uuid,
			...(instance ? { pendingCreationInstance: instance } : {}),
		},
	};
	try {
		if (initialized)
			writeFileAtomicSync(
				filePath,
				JSON.stringify({ version: STORE_VERSION, adapters: next }),
			);
	} catch (error: unknown) {
		logger.warn("Could not persist first-hotspot creation evidence", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return false;
	}
	entries = next;
	return true;
}

export function getPendingHotspotCreation(owner: string): string | undefined {
	return entries[keyFor(owner) ?? ""]?.pendingCreation;
}

export function getPendingHotspotCreationInstance(
	owner: string,
): NmProfileInstance | undefined {
	return entries[keyFor(owner) ?? ""]?.pendingCreationInstance;
}

/** Retire only the completed generated UUID, preserving any newer obligation. */
export function clearHotspotProfileCreation(owner: string, uuid: string): void {
	const entry = entries[keyFor(owner) ?? ""];
	if (entry?.pendingCreation !== uuid) return;
	delete entry.pendingCreation;
	delete entry.pendingCreationInstance;
	persist();
}

/** Injectable view of the store used by the hotspot activation flow. */
export type HotspotCredentialsStore = {
	get(macAddress: string): HotspotCredentials | undefined;
	remember: typeof rememberHotspotCredentials;
	recordCreation?(
		owner: string,
		uuid: string,
		instance?: NmProfileInstance,
	): boolean;
	clearCreation?(owner: string, uuid: string): void;
};

export const hotspotCredentialsStore: HotspotCredentialsStore = {
	get: getHotspotCredentials,
	remember: rememberHotspotCredentials,
	recordCreation: recordHotspotProfileCreation,
	clearCreation: clearHotspotProfileCreation,
};

/** Test seam: drop all in-memory state and disarm persistence. */
export function resetHotspotCredentialsForTest(): void {
	entries = {};
	filePath = HOTSPOT_CREDENTIALS_FILE;
	initialized = false;
}
