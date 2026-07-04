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

import type { AddonConfig, AddonState } from "@ceraui/rpc/schemas";

import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../helpers/config-loader.ts";
import {
	coerceLegacySource,
	RUNTIME_CONFIG_DEFAULTS,
	type RuntimeConfig,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import { logger } from "../helpers/logger.ts";
import { MOCK_CONFIG_PAIRING_DEFAULTS } from "../mocks/mock-config.ts";
import { shouldUseMocks } from "../mocks/mock-service.ts";
import { getPasswordHash, setPasswordHash } from "../rpc/state/password.ts";
import { getSshPasswordHash, setSshPasswordHash } from "./system/ssh.ts";

const CONFIG_FILE = "config.json";

let config: RuntimeConfig = {};

export async function loadConfig() {
	// The default audio source is the "Auto" sentinel (RUNTIME_CONFIG_DEFAULTS):
	// the audio follows the video source, resolved at start/idle-preview. This
	// subsumes the former static per-board asrc guess.
	const result = await loadJsonConfig(
		CONFIG_FILE,
		runtimeConfigSchema,
		RUNTIME_CONFIG_DEFAULTS,
	);
	config = coerceLegacySource(result.data);

	// Apply mock pairing AFTER file load so it overrides any absent/undefined remote_key in config.json
	// shouldUseMocks() is false on real devices.
	if (shouldUseMocks()) {
		Object.assign(config, MOCK_CONFIG_PAIRING_DEFAULTS);
	}

	logger.debug("config loaded", config);

	// Lazy import breaks the config↔audio cycle (audio.ts imports getConfig).
	const { warnIfConfiguredAudioSourceUnavailable } = await import(
		"./streaming/audio.ts"
	);
	warnIfConfiguredAudioSourceUnavailable(config.asrc);

	// Extract and set password hashes (they're stored separately for security)
	setPasswordHash(config.password_hash);
	setSshPasswordHash(config.ssh_pass_hash);

	// Clear password hashes from in-memory config for security
	config.password_hash = undefined;
	config.ssh_pass_hash = undefined;
}

export function saveConfig() {
	const dataToSave: RuntimeConfig = {
		...config,
		password_hash: getPasswordHash(),
		ssh_pass_hash: getSshPasswordHash(),
	};
	// Must stay sync: sync callers (setBitrate/setAutostart) depend on the write
	// finishing before return. Atomic (temp+fsync+rename) so a crash mid-write
	// can't corrupt config.json — add-on state lives here too (E3).
	writeFileAtomicSync(CONFIG_FILE, JSON.stringify(dataToSave));
}

export function getConfig(): RuntimeConfig {
	return config;
}

export function getAddons(): AddonConfig {
	return config.addons ?? {};
}

export function setAddonState(id: string, state: AddonState): void {
	config.addons = { ...getAddons(), [id]: state };
	saveConfig();
}

export function removeAddonState(id: string): void {
	const { [id]: _removed, ...rest } = getAddons();
	config.addons = rest;
	saveConfig();
}
