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

import fs, { constants, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
import {
	RuntimeConfigAuthorityError,
	readRuntimeConfigAuthority,
} from "../helpers/runtime-config-authority.ts";
import { MOCK_CONFIG_PAIRING_DEFAULTS } from "../mocks/mock-config.ts";
import { shouldUseMocks } from "../mocks/mock-service.ts";
import { getPasswordHash, setPasswordHash } from "../rpc/state/password.ts";
import { getSshPasswordHash, setSshPasswordHash } from "./system/ssh.ts";

/**
 * Where the runtime config persists.
 *
 * Bare and CWD-relative BY DESIGN: the shipped unit pins
 * `WorkingDirectory=/opt/ceralive/`, so on a device it always resolves under the
 * service's own state directory. Under a test runner there is no such anchor —
 * the CWD is wherever the suite happened to be invoked from — and `saveConfig()`
 * rewrites the file WHOLE, so a suite exercising the real persistence path
 * against this default overwrites a live `config.json` with its fixtures. Tests
 * therefore redirect it; see `setConfigFilePath`.
 */
let configFile = "config.json";

export function getConfigFilePath(): string {
	return configFile;
}

export function setConfigFilePath(filePath: string): void {
	configFile = filePath;
}

let config: RuntimeConfig = {};
let authorityFailure: RuntimeConfigAuthorityError | undefined;
let pending = false;
let revision = 0;
let inFlight: Promise<void> | undefined;
let publishing: string | undefined;
let failedAttempts = 0;
let scansUntilRetry = 0;

function clearPendingSave(): void {
	pending = false;
	failedAttempts = 0;
	scansUntilRetry = 0;
}

export async function loadConfig() {
	cancelBackgroundPublication();
	clearPendingSave();
	authorityFailure = new RuntimeConfigAuthorityError();
	let raw: unknown;
	try {
		raw = await readRuntimeConfigAuthority(configFile);
	} catch (error) {
		if (error instanceof RuntimeConfigAuthorityError) authorityFailure = error;
		throw error;
	}
	// The default audio source is the "Auto" sentinel (RUNTIME_CONFIG_DEFAULTS):
	// the audio follows the video source, resolved at start/idle-preview. This
	// subsumes the former static per-board asrc guess.
	const result = await loadJsonConfig(
		configFile,
		runtimeConfigSchema,
		RUNTIME_CONFIG_DEFAULTS,
		{ parsed: raw },
	);
	config = coerceLegacySource(result.data);
	authorityFailure = undefined;

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

function configContents(): string {
	if (authorityFailure) throw authorityFailure;
	const dataToSave: RuntimeConfig = {
		...config,
		password_hash: getPasswordHash(),
		ssh_pass_hash: getSshPasswordHash(),
	};
	return JSON.stringify(dataToSave);
}

function cancelBackgroundPublication(): void {
	revision++;
	if (publishing === undefined) return;
	// If async rename wins the race, the sync save follows it. If unlink wins,
	// the queued rename has no source. A staged snapshot cannot win afterward.
	try {
		unlinkSync(publishing);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
}

export function saveConfig() {
	const contents = configContents();
	cancelBackgroundPublication();
	writeFileAtomicSync(configFile, contents);
	clearPendingSave();
}

async function persistPendingConfig(): Promise<void> {
	if (!pending) {
		inFlight = undefined;
		return;
	}
	const target = configFile;
	const temp = join(
		dirname(target),
		`.${basename(target)}.scan.${process.pid}.tmp`,
	);
	const writing = revision;
	let opened = false;
	try {
		const contents = configContents();
		const file = await fs.promises.open(
			temp,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_TRUNC |
				constants.O_NOFOLLOW |
				constants.O_NONBLOCK,
			0o600,
		);
		opened = true;
		try {
			await file.writeFile(contents);
			await file.sync();
		} finally {
			await file.close();
		}
		if (revision !== writing || configFile !== target) return;
		publishing = temp;
		await fs.promises.rename(temp, target);
		opened = false;
		if (revision === writing) clearPendingSave();
	} catch (error) {
		if (pending && !authorityFailure && configFile === target) {
			if (failedAttempts === 0)
				logger.warn("bond: could not persist twin port exclusions", { error });
			// Try the first few commits, then back off by at most eight commits.
			failedAttempts = Math.min(failedAttempts + 1, 6);
			scansUntilRetry = failedAttempts < 3 ? 0 : 2 ** (failedAttempts - 3);
		}
	} finally {
		publishing = undefined;
		if (opened) {
			await fs.promises.unlink(temp).catch((error: unknown) => {
				if (pending && failedAttempts === 0 && configFile === target) {
					failedAttempts = 1;
					logger.warn("bond: could not persist twin port exclusions", {
						error,
					});
				}
			});
		}
		inFlight = undefined;
	}
}

/** A scan may retry a dirty write once; overlapping scans never queue writes. */
export function saveConfigInBackground(
	changed?: boolean,
): Promise<void> | undefined {
	if (changed === undefined) return inFlight;
	if (changed) {
		pending = true;
		revision++;
	}
	if (pending && inFlight === undefined) {
		if (scansUntilRetry > 0) {
			scansUntilRetry--;
			return undefined;
		}
		// Defer even preparation until after the winning scan has published.
		inFlight = Promise.resolve().then(persistPendingConfig);
	}
	return inFlight;
}

/** False until a strict load has succeeded; the boot owner retries until it does. */
export function isRuntimeConfigAvailable(): boolean {
	return authorityFailure === undefined;
}

export function getConfig(): RuntimeConfig {
	if (authorityFailure) throw authorityFailure;
	return config;
}

export function getAddons(): AddonConfig {
	return getConfig().addons ?? {};
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
