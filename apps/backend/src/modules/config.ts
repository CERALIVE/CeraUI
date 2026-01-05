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

import fs from "node:fs";

import { loadJsonConfig, saveJsonConfig } from "../helpers/config-loader.ts";
import {
	RUNTIME_CONFIG_DEFAULTS,
	type RuntimeConfig,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import { logger } from "../helpers/logger.ts";
import { getPasswordHash, setPasswordHash } from "../rpc/state/password.ts";
import { setup } from "./setup.ts";
import { getSshPasswordHash, setSshPasswordHash } from "./system/ssh.ts";

const CONFIG_FILE = "config.json";

let config: RuntimeConfig = {};

export function loadConfig() {
	// Build defaults based on platform
	const platformDefaults = { ...RUNTIME_CONFIG_DEFAULTS };

	// Configure the default audio source depending on the platform
	switch (setup.hw) {
		case "jetson":
			platformDefaults.asrc = fs.existsSync("/dev/hdmi_capture")
				? "HDMI"
				: "C4K";
			break;
		case "rk3588":
			platformDefaults.asrc = fs.existsSync("/dev/hdmirx")
				? "HDMI"
				: "USB audio";
			break;
	}

	const result = loadJsonConfig(
		CONFIG_FILE,
		runtimeConfigSchema,
		platformDefaults,
	);
	config = result.data;

	logger.debug("config loaded", config);

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
	saveJsonConfig(CONFIG_FILE, dataToSave);
}

export function getConfig(): RuntimeConfig {
	return config;
}
