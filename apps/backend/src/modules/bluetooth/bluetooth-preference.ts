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
 * The persisted operator Bluetooth preference.
 *
 * It is its OWN versioned store rather than a `runtimeConfigSchema` key, for the
 * same reason `modem-usage-policy.json` and `hotspot_credentials.json` are:
 * this is durable device state owned by one module, the module is brand-new and
 * self-contained, and a shared-schema edit would couple it to every other
 * config consumer for no gain.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ABSENT IS NOT `false`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `read()` answers `undefined` when the operator has never expressed a
 * preference, and that is NOT the same as "Bluetooth off". The boot reconciler
 * acts on a preference and does nothing at all for an absent one — otherwise the
 * first boot after an update would DISABLE `bluetooth.service` on every device
 * in the field on the strength of a file nobody has written yet, which is
 * exactly the old-image policy this reconciler exists to undo.
 *
 * Writes are INERT until {@link initBluetoothPreferenceStore} runs, mirroring
 * `hotspot-credentials.ts`: a unit test that never opts in cannot litter the
 * working directory.
 */

import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";

/** Bump when the on-disk shape changes; an unknown version is ignored, not guessed. */
export const BLUETOOTH_PREFERENCE_VERSION = 1;

export const BLUETOOTH_PREFERENCE_FILE = "bluetooth.json";

export interface BluetoothPreference {
	/** The operator's own answer to "should this device do Bluetooth". */
	readonly enabled: boolean;
}

export interface BluetoothPreferenceStore {
	/** `undefined` when no preference has ever been recorded. */
	read(): BluetoothPreference | undefined;
	write(preference: BluetoothPreference): void;
}

interface PersistedShape {
	readonly version: number;
	readonly enabled: boolean;
}

function parsePersisted(raw: string): BluetoothPreference | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (err) {
		logger.warn(
			`bluetooth: preference file is not valid JSON; ignoring it: ${String(err)}`,
		);
		return undefined;
	}

	const record = value as Partial<PersistedShape> | null;
	if (record === null || typeof record !== "object") {
		logger.warn("bluetooth: preference file is not an object; ignoring it");
		return undefined;
	}
	if (record.version !== BLUETOOTH_PREFERENCE_VERSION) {
		logger.warn(
			`bluetooth: preference file version ${String(record.version)} is not ${BLUETOOTH_PREFERENCE_VERSION}; ignoring it`,
		);
		return undefined;
	}
	if (typeof record.enabled !== "boolean") {
		logger.warn("bluetooth: preference file carries no boolean `enabled`");
		return undefined;
	}
	return { enabled: record.enabled };
}

let storeDir: string | undefined;

/**
 * Opt the file-backed store in and point it at `dir` (defaults to the working
 * directory, beside `config.json`). Until this runs, the default store neither
 * reads nor writes.
 */
export function initBluetoothPreferenceStore(
	dir: string = process.cwd(),
): void {
	storeDir = dir;
}

/** Test isolation seam — makes the default store inert again. */
export function resetBluetoothPreferenceStore(): void {
	storeDir = undefined;
}

function preferencePath(): string | undefined {
	return storeDir === undefined
		? undefined
		: path.join(storeDir, BLUETOOTH_PREFERENCE_FILE);
}

/** The production store. Inert until {@link initBluetoothPreferenceStore}. */
export const defaultBluetoothPreferenceStore: BluetoothPreferenceStore = {
	read(): BluetoothPreference | undefined {
		const file = preferencePath();
		if (file === undefined) return undefined;
		try {
			// Bun.file().text() is async; this read sits on the synchronous wire
			// path, so it uses the same node:fs surface config-loader.ts does.
			return parsePersisted(readFileSync(file, "utf8"));
		} catch (err) {
			const code = (err as { code?: string } | null)?.code;
			if (code !== "ENOENT") {
				logger.warn(
					`bluetooth: could not read the preference file: ${String(err)}`,
				);
			}
			return undefined;
		}
	},

	write(preference: BluetoothPreference): void {
		const file = preferencePath();
		if (file === undefined) return;
		const body: PersistedShape = {
			version: BLUETOOTH_PREFERENCE_VERSION,
			enabled: preference.enabled,
		};
		try {
			writeFileAtomicSync(file, `${JSON.stringify(body, null, 2)}\n`);
			chmodSync(file, 0o600);
		} catch (err) {
			logger.warn(
				`bluetooth: could not persist the preference: ${String(err)}`,
			);
		}
	},
};

/** An in-memory store — the injected seam every test uses. */
export function createMemoryPreferenceStore(
	initial?: BluetoothPreference,
): BluetoothPreferenceStore {
	let current = initial;
	return {
		read: () => current,
		write: (preference) => {
			current = preference;
		},
	};
}
